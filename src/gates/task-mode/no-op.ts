import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertValidTaskId, readTaskTimelineJsonlEntries } from '../../gate-runtime/task-events';
import { fileSha256, joinOrchestratorPath, normalizePath, resolvePathInsideRepo } from '../shared/helpers';

export const NO_OP_CLASSIFICATIONS = Object.freeze([
    'NO_CHANGES_REQUIRED',
    'ALREADY_DONE',
    'AUDIT_ONLY'
] as const);

export type NoOpClassification = (typeof NO_OP_CLASSIFICATIONS)[number];

interface NoOpClassificationAliases {
    [key: string]: NoOpClassification;
}

const NO_OP_CLASSIFICATION_ALIASES = Object.freeze({
    no_changes_required: 'NO_CHANGES_REQUIRED',
    nochangesrequired: 'NO_CHANGES_REQUIRED',
    no_changes: 'NO_CHANGES_REQUIRED',
    nochange: 'NO_CHANGES_REQUIRED',
    already_done: 'ALREADY_DONE',
    alreadydone: 'ALREADY_DONE',
    audit_only: 'AUDIT_ONLY',
    auditonly: 'AUDIT_ONLY'
} satisfies NoOpClassificationAliases);

export interface NoOpArtifact {
    timestamp_utc: string;
    event_source: 'record-no-op';
    task_id: string;
    status: 'PASSED';
    outcome: 'PASS';
    classification: NoOpClassification;
    reason: string;
    actor: string;
    preflight_path: string | null;
    preflight_sha256: string | null;
}

export interface BuildNoOpArtifactOptions {
    taskId: string;
    classification?: unknown;
    reason: unknown;
    actor?: unknown;
    preflightPath?: unknown;
    preflightSha256?: unknown;
}

export interface NoOpEvidenceResult {
    task_id: string | null;
    evidence_path: string | null;
    evidence_hash: string | null;
    evidence_status: string;
    evidence_outcome: string | null;
    evidence_task_id: string | null;
    evidence_source: string | null;
    classification: string | null;
    reason: string | null;
    preflight_path: string | null;
    preflight_sha256: string | null;
}

export function normalizeNoOpClassification(value: unknown): NoOpClassification {
    const raw = String(value || '').trim();
    if (!raw) {
        return 'NO_CHANGES_REQUIRED';
    }
    const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
    const aliasMatch = NO_OP_CLASSIFICATION_ALIASES[normalized as keyof typeof NO_OP_CLASSIFICATION_ALIASES];
    if (aliasMatch) {
        return aliasMatch;
    }
    const canonicalMatch = NO_OP_CLASSIFICATIONS.find((candidate) => candidate.toLowerCase() === normalized);
    if (canonicalMatch) {
        return canonicalMatch;
    }
    throw new Error(
        `Classification must be one of: ${NO_OP_CLASSIFICATIONS.join(', ')}. ` +
        'Supported aliases: no_changes_required, already_done, audit_only.'
    );
}

export function resolveNoOpArtifactPath(repoRoot: string, taskId: string, artifactPath: string): string {
    const explicitPath = String(artifactPath || '').trim();
    if (explicitPath) {
        const resolvedPath = resolvePathInsideRepo(explicitPath, repoRoot, { allowMissing: true });
        if (!resolvedPath) {
            throw new Error('NoOpArtifactPath must not be empty.');
        }
        return resolvedPath;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-no-op.json`));
}

export function buildNoOpArtifact(options: BuildNoOpArtifactOptions): NoOpArtifact {
    const taskId = assertValidTaskId(options.taskId);
    const classification = normalizeNoOpClassification(options.classification);
    const reason = String(options.reason || '').trim();
    if (reason.length < 12) {
        throw new Error('Reason is required and must be at least 12 characters.');
    }
    const actor = String(options.actor || 'orchestrator').trim() || 'orchestrator';
    const preflightPath = String(options.preflightPath || '').trim();
    const preflightSha256 = String(options.preflightSha256 || '').trim().toLowerCase();

    return {
        timestamp_utc: new Date().toISOString(),
        event_source: 'record-no-op',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        classification,
        reason,
        actor,
        preflight_path: preflightPath ? normalizePath(preflightPath) : null,
        preflight_sha256: preflightSha256 || null
    };
}

function preflightRequiresNoOpHash(preflightPath: string): boolean {
    try {
        const payload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        return !!payload.zero_diff_guard;
    } catch {
        return true;
    }
}

export function getNoOpEvidence(
    repoRoot: string,
    taskId: string | null,
    artifactPath = '',
    expectedPreflightPath = ''
): NoOpEvidenceResult {
    const result: NoOpEvidenceResult = {
        task_id: taskId,
        evidence_path: null,
        evidence_hash: null,
        evidence_status: 'UNKNOWN',
        evidence_outcome: null,
        evidence_task_id: null,
        evidence_source: null,
        classification: null,
        reason: null,
        preflight_path: null,
        preflight_sha256: null
    };

    if (!taskId) {
        result.evidence_status = 'TASK_ID_MISSING';
        return result;
    }

    const resolvedTaskId = assertValidTaskId(taskId);
    const resolvedPath = resolveNoOpArtifactPath(repoRoot, resolvedTaskId, artifactPath);
    result.evidence_path = normalizePath(resolvedPath);

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        result.evidence_status = 'EVIDENCE_FILE_MISSING';
        return result;
    }

    let artifactObject: Record<string, unknown>;
    try {
        artifactObject = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
    } catch {
        result.evidence_status = 'EVIDENCE_INVALID_JSON';
        return result;
    }

    result.evidence_hash = fileSha256(resolvedPath);
    result.evidence_status = String(artifactObject.status || '').trim().toUpperCase();
    result.evidence_outcome = String(artifactObject.outcome || '').trim().toUpperCase();
    result.evidence_task_id = String(artifactObject.task_id || '').trim() || null;
    result.evidence_source = String(artifactObject.event_source || '').trim() || null;
    result.classification = String(artifactObject.classification || '').trim() || null;
    result.reason = String(artifactObject.reason || '').trim() || null;
    result.preflight_path = String(artifactObject.preflight_path || '').trim() || null;
    result.preflight_sha256 = String(artifactObject.preflight_sha256 || '').trim().toLowerCase() || null;

    if (result.evidence_task_id !== resolvedTaskId) {
        result.evidence_status = 'EVIDENCE_TASK_MISMATCH';
        return result;
    }
    if ((result.evidence_source || '').toLowerCase() !== 'record-no-op') {
        result.evidence_status = 'EVIDENCE_SOURCE_INVALID';
        return result;
    }
    if (!result.classification || !NO_OP_CLASSIFICATIONS.includes(result.classification as NoOpClassification)) {
        result.evidence_status = 'EVIDENCE_CLASSIFICATION_INVALID';
        return result;
    }
    if (!result.reason || result.reason.length < 12) {
        result.evidence_status = 'EVIDENCE_REASON_INVALID';
        return result;
    }
    const normalizedExpectedPreflightPath = expectedPreflightPath
        ? normalizePath(resolvePathInsideRepo(expectedPreflightPath, repoRoot, { allowMissing: true }) || expectedPreflightPath)
        : '';
    if (normalizedExpectedPreflightPath) {
        if (!result.preflight_path) {
            result.evidence_status = 'EVIDENCE_PREFLIGHT_PATH_MISSING';
            return result;
        }
        if (normalizePath(result.preflight_path).toLowerCase() !== normalizedExpectedPreflightPath.toLowerCase()) {
            result.evidence_status = 'EVIDENCE_PREFLIGHT_PATH_MISMATCH';
            return result;
        }
        const expectedPreflightSha256 = fileSha256(normalizedExpectedPreflightPath);
        if (!result.preflight_sha256) {
            if (preflightRequiresNoOpHash(normalizedExpectedPreflightPath)) {
                result.evidence_status = 'EVIDENCE_PREFLIGHT_HASH_MISSING';
                return result;
            }
        } else if (
            expectedPreflightSha256
            && result.preflight_sha256.toLowerCase() !== expectedPreflightSha256.toLowerCase()
        ) {
            result.evidence_status = 'EVIDENCE_PREFLIGHT_HASH_MISMATCH';
            return result;
        }
    }
    if (result.evidence_status === 'PASSED' && result.evidence_outcome === 'PASS') {
        result.evidence_status = 'PASS';
        return result;
    }

    result.evidence_status = 'EVIDENCE_NOT_PASS';
    return result;
}

export function getCurrentNoOpEventSha256(
    repoRoot: string,
    taskId: string,
    evidence: NoOpEvidenceResult,
    eventsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'))
): string | null {
    if (evidence.evidence_status !== 'PASS') {
        return null;
    }
    const timelinePath = path.join(eventsRoot, `${assertValidTaskId(taskId)}.jsonl`);
    const events = readTaskTimelineJsonlEntries(timelinePath)
        .map((entry) => entry.record)
        .filter((entry): entry is Readonly<Record<string, unknown>> => entry !== null);
    const lastIndexOfEvent = (eventType: string): number => {
        for (let index = events.length - 1; index >= 0; index -= 1) {
            if (events[index].event_type === eventType) {
                return index;
            }
        }
        return -1;
    };
    const taskEntryIndex = lastIndexOfEvent('TASK_MODE_ENTERED');
    const noOpIndex = lastIndexOfEvent('NO_OP_RECORDED');
    const preflightPassIndex = lastIndexOfEvent('PREFLIGHT_CLASSIFIED');
    const preflightFailIndex = lastIndexOfEvent('PREFLIGHT_FAILED');
    const compilePassIndex = lastIndexOfEvent('COMPILE_GATE_PASSED');
    const compileFailIndex = lastIndexOfEvent('COMPILE_GATE_FAILED');
    if (
        taskEntryIndex < 0
        || preflightPassIndex <= taskEntryIndex
        || preflightFailIndex > preflightPassIndex
        || noOpIndex <= preflightPassIndex
        || noOpIndex <= taskEntryIndex
        || compilePassIndex > noOpIndex
        || compileFailIndex > noOpIndex
    ) {
        return null;
    }
    const event = events[noOpIndex];
    const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
        ? event.details as Record<string, unknown>
        : null;
    const integrity = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
        ? event.integrity as Record<string, unknown>
        : null;
    const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
    if (
        event.task_id !== taskId
        || !/^[0-9a-f]{64}$/u.test(eventSha256)
        || !Number.isFinite(Date.parse(String(event.timestamp_utc || '')))
        || normalizePath(String(details?.artifact_path || '')).toLowerCase() !== String(evidence.evidence_path || '').toLowerCase()
        || String(details?.artifact_sha256 || '').toLowerCase() !== String(evidence.evidence_hash || '').toLowerCase()
        || String(details?.classification || '') !== evidence.classification
        || String(details?.reason || '') !== evidence.reason
        || normalizePath(String(details?.preflight_path || '')).toLowerCase() !== String(evidence.preflight_path || '').toLowerCase()
        || String(details?.preflight_sha256 || '').toLowerCase() !== String(evidence.preflight_sha256 || '').toLowerCase()
    ) {
        return null;
    }
    return eventSha256;
}
