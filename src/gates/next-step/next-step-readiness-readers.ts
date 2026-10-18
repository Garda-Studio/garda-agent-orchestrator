import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadFullSuiteValidationConfig } from '../../core/full-suite-validation-config';
import { inspectFullSuiteReports } from '../full-suite/full-suite-report-evidence';

import {
    type GateOutcome,
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    fileSha256,
    normalizePath
} from '../shared/helpers';
import {
    type TaskAuditSummaryResult
} from '../task-audit/task-audit-summary';

export interface NextStepReadinessArtifactSpec {
    key: string;
    path: string;
}

export interface NextStepReadinessArtifactPaths {
    taskModePath: string;
    preflightPath: string;
    preflightCommandPath: string;
    rulePackPath: string;
    handshakePath: string;
    shellSmokePath: string;
    compileGatePath: string;
    reviewGatePath: string;
    docImpactPath: string;
    fullSuiteValidationPath: string;
    completionGatePath: string;
    semanticCycleRebindPath: string;
    finalCloseoutJsonPath: string;
    finalCloseoutMarkdownPath: string;
}

export interface NextStepReadinessArtifacts {
    paths: NextStepReadinessArtifactPaths;
    taskMode: Record<string, unknown> | null;
    preflight: Record<string, unknown> | null;
    rulePack: Record<string, unknown> | null;
    fullSuiteValidation: Record<string, unknown> | null;
    preflightSha256: string | null;
}

export function readNextStepReadinessArtifacts(params: {
    reviewsRoot: string;
    taskId: string;
    taskModePath: string;
    preflightCommandPath: string;
}): NextStepReadinessArtifacts {
    const paths: NextStepReadinessArtifactPaths = {
        taskModePath: params.taskModePath,
        preflightPath: path.join(params.reviewsRoot, `${params.taskId}-preflight.json`),
        preflightCommandPath: params.preflightCommandPath,
        rulePackPath: path.join(params.reviewsRoot, `${params.taskId}-rule-pack.json`),
        handshakePath: path.join(params.reviewsRoot, `${params.taskId}-handshake.json`),
        shellSmokePath: path.join(params.reviewsRoot, `${params.taskId}-shell-smoke.json`),
        compileGatePath: path.join(params.reviewsRoot, `${params.taskId}-compile-gate.json`),
        reviewGatePath: path.join(params.reviewsRoot, `${params.taskId}-review-gate.json`),
        docImpactPath: path.join(params.reviewsRoot, `${params.taskId}-doc-impact.json`),
        fullSuiteValidationPath: path.join(params.reviewsRoot, `${params.taskId}-full-suite-validation.json`),
        completionGatePath: path.join(params.reviewsRoot, `${params.taskId}-completion-gate.json`),
        semanticCycleRebindPath: path.join(params.reviewsRoot, `${params.taskId}-semantic-cycle-rebind.json`),
        finalCloseoutJsonPath: path.join(params.reviewsRoot, `${params.taskId}-final-closeout.json`),
        finalCloseoutMarkdownPath: path.join(params.reviewsRoot, `${params.taskId}-final-closeout.md`)
    };
    return {
        paths,
        taskMode: safeReadJson(paths.taskModePath),
        preflight: safeReadJson(paths.preflightPath),
        rulePack: safeReadJson(paths.rulePackPath),
        fullSuiteValidation: safeReadJson(paths.fullSuiteValidationPath),
        preflightSha256: fs.existsSync(paths.preflightPath) ? fileSha256(paths.preflightPath) : null
    };
}

export function buildNextStepCoreArtifactSpecs(
    artifacts: NextStepReadinessArtifacts,
    projectMemoryImpactPath?: string | null
): NextStepReadinessArtifactSpec[] {
    return [
        { key: 'task-mode', path: artifacts.paths.taskModePath },
        { key: 'rule-pack', path: artifacts.paths.rulePackPath },
        { key: 'handshake', path: artifacts.paths.handshakePath },
        { key: 'shell-smoke', path: artifacts.paths.shellSmokePath },
        { key: 'preflight', path: artifacts.paths.preflightPath },
        { key: 'compile-gate', path: artifacts.paths.compileGatePath },
        { key: 'review-gate', path: artifacts.paths.reviewGatePath },
        { key: 'doc-impact', path: artifacts.paths.docImpactPath },
        { key: 'full-suite-validation', path: artifacts.paths.fullSuiteValidationPath },
        ...(projectMemoryImpactPath ? [{ key: 'project-memory-impact', path: projectMemoryImpactPath }] : []),
        { key: 'completion-gate', path: artifacts.paths.completionGatePath }
    ];
}

export function hasAcceptedDocsOnlyFullSuiteSkipArtifact(
    reviewsRoot: string,
    taskId: string,
    expectedCommand: string,
    preflightPath: string,
    preflightSha256: string | null,
    summary: TaskAuditSummaryResult
): boolean {
    const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
    const artifact = safeReadJson(artifactPath) as Record<string, unknown> | null;
    if (!artifact) {
        return false;
    }
    return String(artifact.status || '').trim().toUpperCase() === 'SKIPPED'
        && artifact.enabled === true
        && artifact.required === false
        && String(artifact.skip_reason || '').trim() === 'DOCS_ONLY_SCOPE_NOT_REQUIRED'
        && String(artifact.command || '').trim() === expectedCommand
        && fullSuiteArtifactMatchesCurrentCycle(artifact, taskId, preflightPath, preflightSha256, summary);
}

export function fullSuiteArtifactMatchesCurrentCycle(
    artifact: Record<string, unknown> | null,
    taskId: string,
    preflightPath: string,
    preflightSha256: string | null,
    summary: TaskAuditSummaryResult,
    repoRoot?: string
): boolean {
    if (!artifact) {
        return false;
    }
    if (repoRoot && ['PASSED', 'WARNED'].includes(String(artifact.status))) {
        try {
            inspectFullSuiteReports({ repoRoot, taskId, reviewsRoot: path.dirname(preflightPath), artifact,
                declarations: loadFullSuiteValidationConfig(repoRoot).report_files });
        } catch { return false; }
    }
    const rawCycleBinding = artifact.cycle_binding;
    if (!rawCycleBinding || typeof rawCycleBinding !== 'object' || Array.isArray(rawCycleBinding)) {
        return false;
    }
    const cycleBinding = rawCycleBinding as Record<string, unknown>;
    const expectedPreflightPath = normalizePath(preflightPath);
    const expectedPreflightSha256 = String(preflightSha256 || '').trim().toLowerCase();
    if (String(cycleBinding.task_id || '').trim() !== taskId) {
        return false;
    }
    if (normalizePath(cycleBinding.preflight_path || '') !== expectedPreflightPath) {
        return false;
    }
    if (expectedPreflightSha256 && String(cycleBinding.preflight_sha256 || '').trim().toLowerCase() !== expectedPreflightSha256) {
        return false;
    }
    const expectedCompileTimestamp = String(
        summary.gates.find((gate: GateOutcome) => gate.gate === 'compile-gate')?.timestamp_utc || ''
    ).trim();
    const artifactCompileTimestamp = cycleBinding.compile_gate_timestamp == null
        ? ''
        : String(cycleBinding.compile_gate_timestamp || '').trim();
    return !!expectedCompileTimestamp && artifactCompileTimestamp === expectedCompileTimestamp;
}
