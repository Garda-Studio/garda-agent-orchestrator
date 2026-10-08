import * as fs from 'node:fs';
import * as path from 'node:path';

import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { isPlainRecord } from '../../core/records';
import {
    collectCapturedUntrackedFiles,
    collectTrackedChangeFiles,
    collectVisibleUntrackedFiles,
    readPreflightChangedFileScope
} from '../full-suite/full-suite-repair-capture';
import { safeReadJson } from '../task-audit/task-audit-summary-collectors';
import { collectRetainedCompletedQualityInputs } from './next-step-retained-quality-inputs';
import {
    captureAndSuspendSplitRequiredWip
} from '../split-required/split-required-wip-capture';
import type {
    SplitRequiredWipCaptureResult
} from '../split-required/split-required-wip-contracts';
import {
    getStrictDecompositionDecisionEvidence,
    type StrictDecompositionDecisionEvidenceResult
} from '../task-mode/strict-decomposition-decision';
import {
    joinOrchestratorPath
} from '../shared/helpers';

export type StrictDecompositionWipSuspensionResult = SplitRequiredWipCaptureResult | {
    status: 'NOT_REQUIRED';
    manifest_path: null;
    manifest_sha256: null;
    tracked_files: string[];
    untracked_files: string[];
    violations: string[];
};

function noWipSuspensionRequired(): StrictDecompositionWipSuspensionResult {
    return {
        status: 'NOT_REQUIRED',
        manifest_path: null,
        manifest_sha256: null,
        tracked_files: [],
        untracked_files: [],
        violations: []
    };
}

function isRetainedIgnoredRuntimeEvidence(filePath: string): boolean {
    // Match the private split-capture contract; inventory paths are already normalized.
    const lower = filePath.toLowerCase();
    return lower.startsWith('garda-agent-orchestrator/runtime/reviews/')
        || lower.startsWith('garda-agent-orchestrator/runtime/task-events/')
        || lower.startsWith('garda-agent-orchestrator/runtime/task-ledger/')
        || lower.startsWith('garda-agent-orchestrator/runtime/project-memory/')
        || lower.startsWith('garda-agent-orchestrator/runtime/wip/')
        || lower.startsWith('garda-agent-orchestrator/runtime/metrics');
}

function hasCurrentImplementationWip(repoRoot: string, taskId: string, preflightPath: string): boolean {
    try {
        const preflight = safeReadJson(preflightPath);
        if (!isPlainRecord(preflight) || preflight.task_id !== taskId) return true;
        const scope = readPreflightChangedFileScope(repoRoot, preflightPath, taskId);
        if (scope.violations.length > 0) return true;
        const trackedFiles = collectTrackedChangeFiles(repoRoot).all
            .filter(filePath => filePath !== TASK_QUEUE_FILENAME);
        const untrackedFiles = collectVisibleUntrackedFiles(repoRoot)
            .filter(filePath => filePath !== `${TASK_QUEUE_FILENAME}.garda-status-sync.lock/owner.json`);
        if (trackedFiles.length > 0 || untrackedFiles.length > 0) return true;
        const ignoredFiles = collectCapturedUntrackedFiles(repoRoot, taskId, scope.allowed)
            .filter(filePath => !isRetainedIgnoredRuntimeEvidence(filePath));
        if (!ignoredFiles.length) return false;
        const retainedQualityInputs = collectRetainedCompletedQualityInputs(
            repoRoot, taskId, ignoredFiles, scope.allowed
        );
        return ignoredFiles.some(filePath => !retainedQualityInputs.has(filePath));
    } catch {
        // An uncertain inventory must still go through guarded native capture.
        return true;
    }
}

export function suspendStrictDecompositionWipIfRequired(params: {
    repoRoot: string;
    taskId: string;
    evidence?: StrictDecompositionDecisionEvidenceResult;
}): StrictDecompositionWipSuspensionResult {
    const evidence = params.evidence || getStrictDecompositionDecisionEvidence(
        params.repoRoot,
        params.taskId
    );
    if (evidence.evidence_status !== 'PASS' || evidence.decision !== 'split-required') {
        return noWipSuspensionRequired();
    }

    const preflightPath = joinOrchestratorPath(
        params.repoRoot,
        path.join('runtime', 'reviews', `${params.taskId}-preflight.json`)
    );
    if (!fs.existsSync(preflightPath)) {
        return noWipSuspensionRequired();
    }
    if (!hasCurrentImplementationWip(params.repoRoot, params.taskId, preflightPath)) {
        return noWipSuspensionRequired();
    }

    return captureAndSuspendSplitRequiredWip({
        repoRoot: params.repoRoot,
        taskId: params.taskId,
        preflightPath,
        guardKind: 'strict_decomposition',
        guardReason:
            'A current strict decomposition decision requires the implemented parent scope to be suspended before child execution.'
    });
}
