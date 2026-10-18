import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { redactSensitiveData } from '../../../../core/redaction';
import { isPlainRecord } from '../../../../core/records';
import { LIFECYCLE_EVENT_TYPES } from '../../../../gate-runtime/lifecycle-events';
import { appendTaskEventAsync } from '../../../../gate-runtime/task-events';
import * as gateHelpers from '../../../../gates/shared/helpers';

type FullSuiteLifecycleStatus = 'PASSED' | 'FAILED' | 'WARNED' | 'SKIPPED';

const FULL_SUITE_VALIDATION_EVENT_TYPES = new Set<string>([
    LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_PASSED,
    LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_FAILED,
    LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_WARNED,
    LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_SKIPPED
]);

const LATEST_FULL_SUITE_VALIDATION_POINTER_PATH = path.join(
    'runtime',
    'metrics',
    'full-suite-validation-latest.json'
);

function resolveFullSuiteValidationEventType(status: FullSuiteLifecycleStatus): string {
    return {
        PASSED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_PASSED,
        FAILED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_FAILED,
        WARNED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_WARNED,
        SKIPPED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_SKIPPED
    }[status];
}

function resolveFullSuiteValidationOutcome(status: FullSuiteLifecycleStatus): string {
    return status === 'FAILED' ? 'FAIL' : status === 'WARNED' ? 'WARN' : status === 'SKIPPED' ? 'INFO' : 'PASS';
}

function readLatestFullSuiteValidationTransactionId(eventsRoot: string, taskId: string): string | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return null;
    }

    let transactionId: string | null = null;
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const eventType = String(parsed.event_type || '').trim();
            if (!FULL_SUITE_VALIDATION_EVENT_TYPES.has(eventType)) {
                continue;
            }
            const details = parsed.details && typeof parsed.details === 'object'
                ? parsed.details as Record<string, unknown>
                : null;
            const candidate = details ? String(details.artifact_transaction_id || '').trim() : '';
            transactionId = candidate || null;
        } catch {
            // Best-effort only; timeline integrity is validated elsewhere.
        }
    }

    return transactionId;
}

function cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath: string, pendingMetaPath: string): void {
    fs.rmSync(pendingArtifactPath, { force: true });
    fs.rmSync(pendingMetaPath, { force: true });
}

function promotePendingFullSuiteValidationArtifact(
    pendingArtifactPath: string,
    pendingMetaPath: string,
    artifactPath: string
): void {
    fs.copyFileSync(pendingArtifactPath, artifactPath);
    cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath);
}

function writeLatestFullSuiteValidationPointer(
    repoRoot: string,
    taskId: string,
    artifactPath: string,
    status: FullSuiteLifecycleStatus,
    transactionId: string
): void {
    const pointerPath = gateHelpers.joinOrchestratorPath(repoRoot, LATEST_FULL_SUITE_VALIDATION_POINTER_PATH);
    fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
    const pointer = {
        schema_version: 1,
        task_id: taskId,
        status,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        artifact_sha256: gateHelpers.fileSha256(artifactPath) || null,
        artifact_transaction_id: transactionId,
        updated_at_utc: new Date().toISOString()
    };
    const pendingPointerPath = `${pointerPath}.pending`;
    fs.writeFileSync(pendingPointerPath, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
    fs.renameSync(pendingPointerPath, pointerPath);
}

function recoverPendingFullSuiteValidationArtifact(
    eventsRoot: string,
    taskId: string,
    artifactPath: string,
    pendingArtifactPath: string,
    pendingMetaPath: string
): void {
    const pendingArtifactExists = fs.existsSync(pendingArtifactPath);
    const pendingMetaExists = fs.existsSync(pendingMetaPath);
    if (!pendingArtifactExists && !pendingMetaExists) {
        return;
    }

    if (!pendingArtifactExists || !pendingMetaExists) {
        cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath);
        return;
    }

    let pendingTransactionId: string | null = null;
    try {
        const pendingMeta = JSON.parse(fs.readFileSync(pendingMetaPath, 'utf8')) as Record<string, unknown>;
        const candidate = String(pendingMeta.transaction_id || '').trim();
        pendingTransactionId = candidate || null;
    } catch {
        cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath);
        return;
    }

    const latestTransactionId = readLatestFullSuiteValidationTransactionId(eventsRoot, taskId);
    if (pendingTransactionId && latestTransactionId === pendingTransactionId) {
        promotePendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath, artifactPath);
        return;
    }

    cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath);
}

async function appendFullSuiteValidationLifecycleEvent(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    status: FullSuiteLifecycleStatus,
    details: Record<string, unknown>
): Promise<void> {
    const result = await appendTaskEventAsync(
        repoRoot,
        taskId,
        resolveFullSuiteValidationEventType(status),
        resolveFullSuiteValidationOutcome(status),
        `Full-suite validation ${status.toLowerCase()}.`,
        details,
        {
            actor: 'gate',
            passThru: true,
            eventsRoot
        }
    );
    if (!result || !result.integrity) {
        const warningText = result?.warnings.join(' | ') || 'task timeline append failed without diagnostics.';
        throw new Error(`Mandatory lifecycle event '${resolveFullSuiteValidationEventType(status)}' append failed: ${warningText}`);
    }
}

export async function writeArtifactThenEmitMandatoryFullSuiteEvent(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    artifactPath: string,
    status: FullSuiteLifecycleStatus,
    artifact: unknown,
    details: Record<string, unknown>
): Promise<void> {
    const pendingArtifactPath = `${artifactPath}.pending`;
    const pendingMetaPath = `${artifactPath}.pending.meta.json`;
    recoverPendingFullSuiteValidationArtifact(eventsRoot, taskId, artifactPath, pendingArtifactPath, pendingMetaPath);
    const transactionId = randomUUID();
    fs.writeFileSync(pendingArtifactPath, `${JSON.stringify(redactSensitiveData(artifact), null, 2)}\n`, 'utf8');
    fs.writeFileSync(
        pendingMetaPath,
        `${JSON.stringify({ transaction_id: transactionId }, null, 2)}\n`,
        'utf8'
    );
    try {
        await appendFullSuiteValidationLifecycleEvent(repoRoot, eventsRoot, taskId, status, {
            ...details,
            ...(isPlainRecord(artifact) && artifact.report_attempts !== undefined ? { report_attempts: artifact.report_attempts } : {}),
            artifact_transaction_id: transactionId
        });
    } catch (error: unknown) {
        try {
            cleanupPendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath);
        } catch {
            // Best-effort cleanup only; keep the lifecycle emit failure as the primary error.
        }
        throw error;
    }
    try {
        promotePendingFullSuiteValidationArtifact(pendingArtifactPath, pendingMetaPath, artifactPath);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Mandatory lifecycle event '${resolveFullSuiteValidationEventType(status)}' was recorded, ` +
            `but canonical artifact promotion failed: ${message}. ` +
            `Pending artifact retained at '${gateHelpers.normalizePath(pendingArtifactPath)}' for recovery on the next full-suite-validation run.`
        );
    }
    writeLatestFullSuiteValidationPointer(repoRoot, taskId, artifactPath, status, transactionId);
}
