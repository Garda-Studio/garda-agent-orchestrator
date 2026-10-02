import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPlainRecord } from '../../../../core/records';
import { writeReviewClassificationSnapshot } from '../../../../gates/review-remediation/review-remediation-classification-evidence';
import {
    appendMandatoryTaskEvent
} from '../../../../gate-runtime/task-events';
import { getPreflightContext } from '../../../../gates/compile/compile-gate';
import {
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigChangedFiles
} from '../../../../gates/workflow-config/workflow-config-work';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    resolveDefaultReviewsPath,
    writeJsonArtifact
} from '../../../gate-cli/gates-artifacts';
import {
    resolveOrchestratorRoot
} from '../compile/gate-flow-helpers';

export function ensureRestartStepPassed(
    stepName: string,
    result: { outputLines: string[]; exitCode: number }
): void {
    if (result.exitCode !== 0) {
        throw new Error(`${stepName} failed during coherent-cycle restart.\n${result.outputLines.join('\n')}`.trim());
    }
}

export function resolveRecoveryPreflightPath(
    repoRoot: string,
    taskId: string,
    pathValue: unknown,
    label: string
): string {
    const defaultPreflightPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-preflight.json`)
    );
    const requestedPath = String(pathValue || defaultPreflightPath).trim() || defaultPreflightPath;
    const resolvedPath = gateHelpers.resolvePathInsideRepo(requestedPath, repoRoot, {
        allowMissing: true,
        enforceInside: false
    });
    if (!resolvedPath || !gateHelpers.isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: true })) {
        throw new Error(
            `${label} must resolve inside repo root without symlink or junction escape: `
            + gateHelpers.normalizePath(resolvedPath || requestedPath)
        );
    }
    return resolvedPath;
}

export function requireRestartArtifactSha256(artifactPath: string, label: string): string {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        throw new Error(`${label} artifact is missing after restart success: ${gateHelpers.normalizePath(artifactPath)}`);
    }
    const sha256 = gateHelpers.fileSha256(artifactPath);
    if (!sha256) {
        throw new Error(`${label} artifact hash could not be computed after restart success: ${gateHelpers.normalizePath(artifactPath)}`);
    }
    return sha256;
}

export function toNonNegativeRestartCount(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function collectRequiredRestartReviewTypes(requiredReviews: Record<string, boolean>): string[] {
    return Object.entries(requiredReviews)
        .filter(([, required]) => required === true)
        .map(([reviewType]) => reviewType)
        .sort();
}

export function appendRestartCompletedEvidence(input: {
    repoRoot: string;
    taskId: string;
    eventType: 'COHERENT_CYCLE_RESTARTED' | 'REVIEW_CYCLE_RESTARTED';
    artifactSuffix: '-coherent-cycle-restart.json' | '-review-cycle-restart.json';
    message: string;
    taskModePath: string;
    preflightPath: string;
    compileEvidencePath: string;
    detectionSource: string;
    plannedChangedFilesCount: number;
    detectedChangedFilesCount: number;
    elapsedMs: number;
    restartReason: string;
    nextStepSummary: string;
    extraDetails?: Record<string, unknown>;
}): string {
    const artifactPath = resolveDefaultReviewsPath(input.repoRoot, `${input.taskId}${input.artifactSuffix}`);
    const extraDetails = { ...input.extraDetails };
    const classification = extraDetails.authoritative_review_classification;
    if (isPlainRecord(classification) && classification.source === 'delta') {
        extraDetails.authoritative_review_classification_reference = writeReviewClassificationSnapshot({
            reviewsRoot: path.dirname(artifactPath), taskId: input.taskId, classification
        });
        delete extraDetails.authoritative_review_classification;
    }
    const baseDetails = {
        restart_event_schema_version: 1,
        task_id: input.taskId,
        event_type: input.eventType,
        status: 'PASSED',
        task_mode_path: gateHelpers.normalizePath(input.taskModePath),
        task_mode_sha256: requireRestartArtifactSha256(input.taskModePath, 'task-mode'),
        preflight_path: gateHelpers.normalizePath(input.preflightPath),
        preflight_sha256: requireRestartArtifactSha256(input.preflightPath, 'preflight'),
        compile_evidence_path: gateHelpers.normalizePath(input.compileEvidencePath),
        compile_evidence_sha256: requireRestartArtifactSha256(input.compileEvidencePath, 'compile-gate'),
        detection_source: input.detectionSource,
        planned_changed_files_count: input.plannedChangedFilesCount,
        detected_changed_files_count: input.detectedChangedFilesCount,
        elapsed_ms: Math.max(0, Math.floor(input.elapsedMs)),
        restart_reason: input.restartReason,
        next_step_summary: input.nextStepSummary,
        ...extraDetails
    };
    writeJsonArtifact(artifactPath, {
        schema_version: 1,
        event_source: input.eventType === 'COHERENT_CYCLE_RESTARTED'
            ? 'restart-coherent-cycle'
            : 'restart-review-cycle',
        recorded_at_utc: new Date().toISOString(),
        ...baseDetails
    });
    const restartArtifactSha256 = requireRestartArtifactSha256(artifactPath, 'restart-cycle');
    appendMandatoryTaskEvent(
        resolveOrchestratorRoot(input.repoRoot),
        input.taskId,
        input.eventType,
        'PASS',
        input.message,
        {
            ...baseDetails,
            restart_artifact_path: gateHelpers.normalizePath(artifactPath),
            restart_artifact_sha256: restartArtifactSha256
        },
        { actor: 'orchestrator' }
    );
    return artifactPath;
}

function toPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function getWorkflowConfigPathList(value: unknown): string[] {
    return Array.isArray(value)
        ? getWorkflowConfigChangedFiles(value.map((entry) => String(entry || '')))
        : [];
}

function getWorkflowConfigHashEvidence(value: unknown): Record<string, string | null> {
    const record = toPlainRecord(value);
    if (!record) {
        return {};
    }
    const hashes: Record<string, string | null> = {};
    for (const [rawPath, rawHash] of Object.entries(record)) {
        const [normalizedPath] = getWorkflowConfigChangedFiles([rawPath]);
        if (!normalizedPath) {
            continue;
        }
        if (rawHash === null) {
            hashes[normalizedPath] = null;
            continue;
        }
        const hashText = String(rawHash || '').trim().toLowerCase();
        if (/^[a-f0-9]{64}$/.test(hashText)) {
            hashes[normalizedPath] = hashText;
        }
    }
    return hashes;
}

export function resolveRestartAllowedDirtyWorkflowConfigFiles(
    repoRoot: string,
    previousPreflight: ReturnType<typeof getPreflightContext>,
    plannedChangedFiles: readonly string[]
): string[] {
    const preflightRecord = toPlainRecord(previousPreflight.preflight);
    const triggers = toPlainRecord(preflightRecord?.triggers);
    const preflightWorkflowConfigFiles = new Set([
        ...getWorkflowConfigChangedFiles(previousPreflight.changed_files.map((entry) => String(entry || ''))),
        ...getWorkflowConfigPathList(triggers?.changed_workflow_config_files)
    ]);
    const previousHashEvidence = getWorkflowConfigHashEvidence(triggers?.workflow_config_file_hashes);
    if (preflightWorkflowConfigFiles.size === 0 || Object.keys(previousHashEvidence).length === 0) {
        return [];
    }
    const currentHashes = getCurrentWorkflowConfigFileHashes(repoRoot);
    return getWorkflowConfigChangedFiles(plannedChangedFiles)
        .filter((relativePath) => (
            preflightWorkflowConfigFiles.has(relativePath)
            && Object.prototype.hasOwnProperty.call(previousHashEvidence, relativePath)
            && (currentHashes[relativePath] ?? null) === previousHashEvidence[relativePath]
        ))
        .sort();
}
