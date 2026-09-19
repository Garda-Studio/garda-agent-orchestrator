import * as fs from 'node:fs';
import * as path from 'node:path';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import { resolveTaskHistoryLedgerPath } from '../../gate-runtime/task-history-ledger';
import { readTaskTimelineFileMetadataSnapshot } from '../../gate-runtime/task-events';
import { fileSha256, toPosix } from '../shared/helpers';
import { parseTimestamp, type TaskCycleBindingSnapshot } from '../task-events-summary/task-events-summary';
import { type ProjectMemoryImpactLifecycleEvidence } from '../project-memory-impact';
import {
    collectKnownRequiredReviewTypes,
    safeReadJson,
    safeReviewArtifactFileSha256,
    type BlockerEntry,
    type EvidenceArtifact
} from './task-audit-summary-collectors';
import { collectEffectiveReviewTypeIds } from './task-audit-summary-review-common';
import { type TaskAuditEvent } from './task-audit-summary-lifecycle';

// Artifact name patterns relative to reviews root, keyed by kind.
const BASE_ARTIFACT_PATTERNS: ReadonlyArray<{ kind: string; suffix: string }> = [
    { kind: 'task-mode', suffix: '-task-mode.json' },
    { kind: 'rule-pack', suffix: '-rule-pack.json' },
    { kind: 'handshake', suffix: '-handshake.json' },
    { kind: 'shell-smoke', suffix: '-shell-smoke.json' },
    { kind: 'preflight', suffix: '-preflight.json' },
    { kind: 'compile-gate', suffix: '-compile-gate.json' },
    { kind: 'compile-output', suffix: '-compile-output.log' },
    { kind: 'coherent-cycle-restart', suffix: '-coherent-cycle-restart.json' },
    { kind: 'review-cycle-restart', suffix: '-review-cycle-restart.json' },
    { kind: 'review-gate', suffix: '-review-gate.json' },
    { kind: 'doc-impact', suffix: '-doc-impact.json' },
    { kind: 'full-suite-validation', suffix: '-full-suite-validation.json' },
    { kind: 'full-suite-output', suffix: '-full-suite-output.log' },
    { kind: 'optional-skill-selection', suffix: '-optional-skill-selection.json' },
    { kind: 'final-closeout-json', suffix: '-final-closeout.json' },
    { kind: 'final-closeout-markdown', suffix: '-final-closeout.md' },
    { kind: 'final-user-report', suffix: '-final-user-report.md' },
    { kind: 'no-op', suffix: '-no-op.json' }
];

function buildArtifactPatterns(
    currentPreflight?: Record<string, unknown> | null
): ReadonlyArray<{ kind: string; suffix: string }> {
    const reviewPatterns = collectEffectiveReviewTypeIds(currentPreflight)
        .flatMap((reviewType) => [
            { kind: `${reviewType}-review`, suffix: `-${reviewType}.md` },
            { kind: `${reviewType}-review-context`, suffix: `-${reviewType}-review-context.json` },
            { kind: `${reviewType}-receipt`, suffix: `-${reviewType}-receipt.json` }
        ]);
    return [...BASE_ARTIFACT_PATTERNS, ...reviewPatterns];
}

function buildRequiredReviewBlocker(reviewType: string, taskId: string, reviewsRoot: string): BlockerEntry | null {
    const gate = `${reviewType}-review`;
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const reviewPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const hasReceipt = fs.existsSync(receiptPath);
    const hasReview = fs.existsSync(reviewPath);

    if (!hasReceipt && !hasReview) {
        return { gate, reason: `Required ${reviewType} review artifact not found` };
    }
    if (!hasReceipt) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt not found (review markdown exists but receipt is missing)`
        };
    }
    if (!hasReview) {
        return {
            gate,
            reason: `Required ${reviewType} review markdown not found (receipt exists but review document is missing)`
        };
    }

    const receipt = safeReadJson(receiptPath);
    if (!receipt) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt is malformed or unreadable`
        };
    }
    if (receipt.task_id !== taskId) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt belongs to a different task: ${receipt.task_id}`
        };
    }
    if (receipt.review_type !== reviewType) {
        return {
            gate,
            reason: `Required ${reviewType} review receipt has mismatched review type: ${receipt.review_type}`
        };
    }
    if (typeof receipt.review_artifact_sha256 === 'string' && receipt.review_artifact_sha256) {
        const actualHash = safeReviewArtifactFileSha256(reviewPath);
        if (actualHash && receipt.review_artifact_sha256 !== actualHash) {
            return {
                gate,
                reason: `Required ${reviewType} review artifact was modified after receipt was issued`
            };
        }
    }

    return null;
}

function shouldValidateRequiredReviewArtifactForCurrentCycle(
    reviewType: string,
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null
): boolean {
    if (!currentCycle?.compile_gate_timestamp) {
        return true;
    }

    const compileGateTime = parseTimestamp(currentCycle.compile_gate_timestamp).getTime();
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventTime = parseTimestamp(event.timestamp_utc).getTime();
        if (eventTime > 0 && compileGateTime > 0 && eventTime < compileGateTime) {
            continue;
        }

        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (
            eventType === 'REVIEW_GATE_PASSED'
            || eventType === 'REVIEW_GATE_PASSED_WITH_OVERRIDE'
            || eventType === 'REVIEW_GATE_FAILED'
            || eventType === 'COMPLETION_GATE_PASSED'
            || eventType === 'COMPLETION_GATE_FAILED'
        ) {
            return true;
        }

        if (eventType !== 'REVIEW_RECORDED') {
            continue;
        }
        const details = event.details && typeof event.details === 'object'
            ? event.details as Record<string, unknown>
            : null;
        const recordedReviewType = String(
            details?.review_type
            || details?.reviewType
            || ''
        ).trim().toLowerCase();
        if (recordedReviewType === reviewType) {
            return true;
        }
    }

    return false;
}

export function collectRequiredReviewBlockers(
    requiredReviews: Record<string, boolean>,
    taskId: string,
    reviewsRoot: string,
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    currentPreflight?: Record<string, unknown> | null
): BlockerEntry[] {
    return withReviewArtifactReadBarrier(reviewsRoot, () => (
        collectKnownRequiredReviewTypes(requiredReviews, currentPreflight)
            .flatMap((reviewType) => {
                if (!shouldValidateRequiredReviewArtifactForCurrentCycle(reviewType, events, currentCycle)) {
                    return [];
                }
                const blocker = buildRequiredReviewBlocker(reviewType, taskId, reviewsRoot);
                return blocker ? [blocker] : [];
            })
    ));
}

export function collectEvidenceArtifacts(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    taskEventFile: string,
    projectMemoryImpact: ProjectMemoryImpactLifecycleEvidence,
    currentPreflight?: Record<string, unknown> | null
): EvidenceArtifact[] {
    const evidence = withReviewArtifactReadBarrier(reviewsRoot, () => (
        buildArtifactPatterns(currentPreflight).map(({ kind, suffix }) => {
            const artifactPath = path.join(reviewsRoot, `${taskId}${suffix}`);
            const exists = fs.existsSync(artifactPath);
            return {
                kind,
                path: toPosix(artifactPath),
                exists,
                sha256: exists ? safeReviewArtifactFileSha256(artifactPath) : null
            };
        })
    ));

    if (projectMemoryImpact.required || projectMemoryImpact.evidence_status !== 'NOT_REQUIRED') {
        for (const [kind, artifactPath] of [
            ['project-memory-impact', projectMemoryImpact.artifact_path],
            ['project-memory-update', projectMemoryImpact.update_artifact_path]
        ] as const) {
            const resolvedPath = path.resolve(repoRoot, artifactPath);
            const exists = fs.existsSync(resolvedPath);
            evidence.push({
                kind,
                path: toPosix(resolvedPath),
                exists,
                sha256: exists ? safeReviewArtifactFileSha256(resolvedPath) : null
            });
        }
    }

    const taskTimelineSnapshot = readTaskTimelineFileMetadataSnapshot(taskEventFile);
    const taskTimelineExists = taskTimelineSnapshot.active
        ? taskTimelineSnapshot.valid && taskTimelineSnapshot.exists
        : fs.existsSync(taskEventFile);
    evidence.push({
        kind: 'task-events',
        path: toPosix(taskEventFile),
        exists: taskTimelineExists,
        sha256: taskTimelineSnapshot.active
            ? taskTimelineSnapshot.sha256
            : taskTimelineExists ? fileSha256(taskEventFile) : null
    });
    evidence.push({
        kind: 'task-ledger',
        path: toPosix(resolveTaskHistoryLedgerPath(path.dirname(path.dirname(reviewsRoot)), taskId)),
        exists: false,
        sha256: null
    });

    return evidence;
}
