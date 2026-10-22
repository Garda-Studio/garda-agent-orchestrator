import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { runGit } from '../../core/git-helpers';
import { splitNulRecords } from '../../core/git-path-output';
import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { prepareValidationReportCapture, completeValidationReportCapture } from '../../core/validation-report-capture';
import { readRetainedValidationReports } from '../../core/validation-report-evidence';
import { validationDigest } from '../../core/project-validation-identity';
import type { ValidationReportCapture } from '../../core/validation-report-contract';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../gate-runtime/task-events-locking';
import { executeCommandAsync } from '../../cli/gate-cli/gates-subprocess';
import { inspectValidationCommand } from '../../core/validation-command-contract';
import { loadFullSuiteValidationConfig } from '../../core/full-suite-validation-config';
import { isDeepStrictEqual } from 'node:util';
import { captureParentSource, parentChildSourceIdentity, readAcceptedParentChildren } from './parent-audit-graph';
import { parentArtifactPath, parentDigest, parentRecordDigest, publishParentRecord, readParentRecord, withParentAuditMutation, writeParentAuditArtifact } from './parent-audit-auth';
import { readParentCompletionContract } from './parent-audit-contract';
import type { ParentCompletionContract, ParentRecord } from './parent-audit-types';
import { readParentAuditProofBytes } from '../task-audit/task-audit-summary-decomposed-parent-proofs';

export interface ParentValidation extends ParentRecord {
    command: string;
    status: 'RUNNING' | 'PASSED' | 'FAILED';
    attempt_id: string;
    contract_sha256: string;
    source_commit: string;
    source_tree: string;
    child_sources: ReturnType<typeof parentChildSourceIdentity>;
    output_path: string | null;
    output_sha256: string | null;
    report_capture?: ValidationReportCapture | null;
    report_directory?: string;
    report_start_sha256?: string | null;
    report_violations?: string[];
}

export function parentValidationKind(command: string): string {
    return 'validation-' + parentDigest(command).slice(0, 24);
}

export function readParentValidations(root: string, contract: ParentCompletionContract): Array<ParentValidation | null> {
    if (!contract.original_commands.length) return [];
    const source = captureParentSource(root), children = parentChildSourceIdentity(readAcceptedParentChildren(root, contract));
    return contract.original_commands.map(command => {
        const proof = readParentRecord<ParentValidation>(root, contract.task_id, parentValidationKind(command));
        if (!proof || proof.status === 'RUNNING' || proof.command !== command || proof.contract_sha256 !== parentRecordDigest(contract)
            || proof.source_commit !== source.commitSha || proof.source_tree !== source.treeSha || !isDeepStrictEqual(proof.child_sources, children)) return null;
        if (!proof.output_path || !proof.output_sha256 || !/^[a-f0-9-]{36}$/u.test(proof.attempt_id)
            || proof.output_path !== parentArtifactPath(root, contract.task_id, proof.kind + '-output-' + proof.attempt_id).replace(/\.json$/u, '.log')
            || parentDigest(readParentAuditProofBytes(root, proof.output_path, proof.output_sha256)) !== proof.output_sha256) {
            throw new Error('Parent validation output is missing or changed.');
        }
        if (contract.original_reports[command]?.length) {
            const reports = readRetainedValidationReports({ repoRoot: root, capture: proof.report_capture,
                declarations: contract.original_reports[command], evidenceDirectory: proof.report_directory ?? '',
                expectedStartSha256: proof.report_start_sha256 ?? null, executionViolations: proof.report_violations ?? [] });
            if (reports.violations.length && proof.status === 'PASSED') throw new Error('Failed parent reports cannot become accepted evidence.');
        }
        return proof;
    });
}

export async function runParentValidation(root: string, taskId: string, commandIndex: number): Promise<ParentValidation> {
    const { handle } = acquireFilesystemLock(parentArtifactPath(root, taskId, 'validation-lock'),
        { ownerLabel: 'parent-validation', requireKnownDeadOwner: true });
    try { return await executeParentValidation(root, taskId, commandIndex); }
    finally { releaseFilesystemLock(handle); }
}

async function executeParentValidation(root: string, taskId: string, commandIndex: number): Promise<ParentValidation> {
    const started = withParentAuditMutation(root, taskId, () => {
        const contract = readParentCompletionContract(root, taskId);
        if (!contract || readParentRecord(root, taskId, 'result') || readParentRecord(root, taskId, 'review-observation')) throw new Error('Parent validation is unavailable after its one-shot audit.');
        const command = contract.original_commands[commandIndex];
        if (!Number.isSafeInteger(commandIndex) || !command) throw new Error('Parent validation command index is not declared.');
        const admission = inspectValidationCommand(command, 'validation');
        if (!admission.supported) throw new Error(admission.violation || 'Unsupported parent validation command.');
        const source = captureParentSource(root), children = parentChildSourceIdentity(readAcceptedParentChildren(root, contract));
        const attemptId = randomUUID();
        const reportDirectory = path.relative(root, parentArtifactPath(root, taskId, 'validation-reports-' + attemptId)).replace(/\\/gu, '/');
        const reportStart = prepareValidationReportCapture(root, contract.original_reports[command], { evidenceDirectory: reportDirectory,
            excludedPaths: [...splitNulRecords(runGit(root, ['ls-files', '-z'], { timeoutMs: 10000, maxBuffer: 8 * 1024 * 1024 })), 'TASK.md'],
            excludedRoots: ['.git', ...['live', 'runtime/reviews', 'runtime/task-events'].map(directory => path.relative(root, joinOrchestratorPath(root, directory)).replace(/\\/gu, '/'))] });
        const proof = publishParentRecord(root, {
            schema_version: 1, event_source: 'parent-audit', task_id: taskId, kind: parentValidationKind(command), command,
            status: 'RUNNING', attempt_id: attemptId, contract_sha256: parentRecordDigest(contract), source_commit: source.commitSha,
            source_tree: source.treeSha, child_sources: children, output_path: null, output_sha256: null,
            report_directory: reportDirectory, report_start_sha256: reportStart ? validationDigest(reportStart) : null
        } satisfies ParentValidation);
        return { contract, proof, reportStart };
    });
    const execution = await executeCommandAsync(started.proof.command, { cwd: root, timeoutMs: loadFullSuiteValidationConfig(root).timeout_ms, captureInvocations: true });
    const reportCapture = completeValidationReportCapture(root, started.reportStart);
    return withParentAuditMutation(root, taskId, () => {
        const current = readParentRecord<ParentValidation>(root, taskId, started.proof.kind);
        const contract = readParentCompletionContract(root, taskId), source = captureParentSource(root);
        if (current?.attempt_id !== started.proof.attempt_id || !contract || parentRecordDigest(contract) !== started.proof.contract_sha256
            || source.commitSha !== started.proof.source_commit || source.treeSha !== started.proof.source_tree
            || !isDeepStrictEqual(parentChildSourceIdentity(readAcceptedParentChildren(root, contract)), started.proof.child_sources)) {
            throw new Error('Parent validation source, graph or current invocation changed.');
        }
        const outputPath = parentArtifactPath(root, taskId, started.proof.kind + '-output-' + started.proof.attempt_id).replace(/\.json$/u, '.log');
        const retainedReports = reportCapture ? readRetainedValidationReports({ repoRoot: root, capture: reportCapture,
            declarations: contract.original_reports[started.proof.command], evidenceDirectory: started.proof.report_directory,
            expectedStartSha256: started.proof.report_start_sha256, executionViolations: reportCapture.violations }) : null;
        const output = [...execution.outputLines, ...(retainedReports?.texts ?? []), ...(retainedReports?.violations ?? [])].join('\n') + '\n';
        writeParentAuditArtifact(root, outputPath, output);
        return publishParentRecord(root, { ...started.proof, status: execution.exitCode === 0 && !execution.timedOut && !execution.cancelled
            && !execution.outputTruncated && !execution.sinkError && !retainedReports?.violations.length ? 'PASSED' : 'FAILED', output_path: outputPath, output_sha256: parentDigest(output),
            ...(reportCapture ? { report_capture: reportCapture, report_violations: reportCapture.violations } : {}),
            exit_code: execution.exitCode, timed_out: execution.timedOut, cancelled: execution.cancelled, invocations: execution.invocations } satisfies ParentValidation);
    });
}
