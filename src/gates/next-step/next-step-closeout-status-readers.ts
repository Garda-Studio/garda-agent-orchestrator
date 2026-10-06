import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import {
    getCycleBindingSnapshotFromPayload
} from '../task-events-summary/task-events-summary';
import {
    formatFinalCloseoutMarkdown,
    formatFinalUserReport,
    type TaskAuditSummaryResult
} from '../task-audit/task-audit-summary';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import { getCurrentNoOpEventSha256, getNoOpEvidence } from '../task-mode/no-op';
import { isFullSuiteNotRequiredForZeroDiffNoReviewableScope } from '../full-suite/full-suite-validation-results';
import {
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    describePathList,
    getDocImpactDeclaredDocsUpdated,
    readPreflightWorkspaceReadiness
} from './next-step-compile-full-suite-readiness';
import {
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    getWorkspaceSnapshotCached,
    resolveWorkspaceSnapshotRequest,
    type WorkspaceSnapshot,
    type WorkspaceSnapshotRequest
} from '../workspace/workspace-snapshot-cache';
import {
    evaluateStagedPostDoneAuditedScope,
    getUnexpectedPostDoneWorkspaceFiles,
    readPostDoneAuditedScopeFingerprint
} from '../task-audit/task-audit-summary-drift';
import { isPlainRecord } from '../../core/records';
import { canonicalPathList } from '../shared/canonical-path-list';

export interface NextStepFinalReportSummary {
    closeout_json_path: string;
    closeout_markdown_path: string;
    final_user_report_path: string;
    final_user_report_body: string;
    final_user_report_sha256: string;
    required_order: string[];
    commit_command_suggestion: string;
    commit_question: string;
}

export interface PostDoneWorkspaceDriftDecision {
    blocked: boolean;
    reason: string;
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function getPreflightChangedFiles(preflight: Record<string, unknown> | null): string[] {
    return Array.isArray(preflight?.changed_files)
        ? canonicalPathList(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))
        : [];
}

function getPostDoneAuditedChangedFiles(
    preflight: Record<string, unknown> | null,
    docImpactPath: string
): string[] {
    return canonicalPathList([
        ...getPreflightChangedFiles(preflight),
        ...getDocImpactDeclaredDocsUpdated(docImpactPath).map((entry) => normalizePath(entry)).filter(Boolean)
    ]);
}

function isFinalReportCommitCommandSuggestion(value: string): boolean {
    const text = String(value || '').trim();
    return /^git commit -m /u.test(text)
        || /\bgarda(?:\.js)?\s+gate\s+human-commit\b/u.test(text)
        || /\bhuman-commit\s+--operator-confirmed\s+yes\b/u.test(text);
}

export function buildFinalReportOrder(summary: TaskAuditSummaryResult): string[] {
    const contractOrder = summary.final_report_contract.required_order.length > 0
        ? summary.final_report_contract.required_order
        : [
            'short agent-authored summary of what changed',
            'verbatim Garda final user report'
        ];
    const reportOrder = contractOrder
        .map((entry) => entry === 'implementation summary' ? 'short agent-authored summary of what changed' : entry)
        .filter((entry) => !isFinalReportCommitCommandSuggestion(entry))
        .filter((entry) => entry !== 'Do you want me to commit now? (yes/no)' && entry !== 'No commit confirmation required.')
        .filter((entry) => String(entry || '').trim().length > 0);
    if (
        isFinalReportCommitCommandSuggestion(summary.final_report_contract.commit_command_suggestion || '') &&
        summary.final_report_contract.commit_question === 'Do you want me to commit now? (yes/no)'
    ) {
        reportOrder.push(summary.final_report_contract.commit_command_suggestion);
        reportOrder.push(summary.final_report_contract.commit_question);
    }
    return reportOrder;
}

function finalCloseoutMatchesCurrentCycle(
    expected: TaskAuditSummaryResult['final_closeout']['cycle_binding'] | null | undefined,
    actualPayload: Record<string, unknown>,
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    eventsRoot: string
): boolean {
    const expectedBinding = expected || null;
    const actualBinding = getCycleBindingSnapshotFromPayload(actualPayload, repoRoot);
    if (expectedBinding?.no_op_sha256 || (actualBinding && !actualBinding.compile_gate_timestamp)) {
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const preflight = safeReadJson(preflightPath);
        const noOpEvidence = getNoOpEvidence(
            repoRoot,
            taskId,
            path.join(reviewsRoot, `${taskId}-no-op.json`),
            preflightPath
        );
        const currentNoOpEventSha256 = getCurrentNoOpEventSha256(repoRoot, taskId, noOpEvidence, eventsRoot);
        const actualNoOpSha256 = isPlainRecord(actualPayload.cycle_binding)
            ? normalizeSha256(actualPayload.cycle_binding.no_op_sha256)
            : null;
        const actualNoOpEventSha256 = isPlainRecord(actualPayload.cycle_binding)
            ? normalizeSha256(actualPayload.cycle_binding.no_op_event_sha256)
            : null;
        return !!preflight
            && isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflight)
            && Array.isArray(preflight.changed_files)
            && preflight.changed_files.length === 0
            && noOpEvidence.evidence_status === 'PASS'
            && expectedBinding?.compile_gate_timestamp == null
            && actualBinding?.compile_gate_timestamp == null
            && !!expectedBinding?.no_op_sha256
            && expectedBinding.no_op_sha256 === actualNoOpSha256
            && actualNoOpSha256 === noOpEvidence.evidence_hash
            && !!currentNoOpEventSha256
            && expectedBinding.no_op_event_sha256 === actualNoOpEventSha256
            && actualNoOpEventSha256 === currentNoOpEventSha256
            && expectedBinding.preflight_path === actualBinding?.preflight_path
            && expectedBinding.preflight_sha256 === actualBinding?.preflight_sha256
            && expectedBinding.preflight_sha256 === noOpEvidence.preflight_sha256;
    }
    if (!expectedBinding?.compile_gate_timestamp || !actualBinding?.compile_gate_timestamp) {
        return false;
    }
    if (actualBinding.compile_gate_timestamp !== expectedBinding.compile_gate_timestamp) {
        return false;
    }
    if (expectedBinding.preflight_sha256 && actualBinding.preflight_sha256 !== expectedBinding.preflight_sha256) {
        return false;
    }
    return !(expectedBinding.preflight_path && actualBinding.preflight_path !== expectedBinding.preflight_path);
}

function finalCloseoutMatchesMaterializedLedger(
    reviewsRoot: string,
    taskId: string,
    closeout: Record<string, unknown>,
    closeoutJsonPath: string,
    closeoutMarkdownPath: string
): boolean {
    const ledgerPath = path.join(path.dirname(reviewsRoot), 'task-ledger', `${taskId}.json`);
    const ledger = safeReadJson(ledgerPath);
    if (!isPlainRecord(ledger) || String(ledger.task_id || '').trim() !== taskId) {
        return false;
    }
    const verification = isPlainRecord(ledger.verification) ? ledger.verification : null;
    const artifactRefs = isPlainRecord(ledger.artifact_refs) ? ledger.artifact_refs : null;
    const jsonRef = isPlainRecord(artifactRefs?.final_closeout_json) ? artifactRefs.final_closeout_json : null;
    const markdownRef = isPlainRecord(artifactRefs?.final_closeout_markdown) ? artifactRefs.final_closeout_markdown : null;
    const expectedJsonSha256 = typeof jsonRef?.sha256 === 'string' ? jsonRef.sha256.trim().toLowerCase() : '';
    const expectedMarkdownSha256 = typeof markdownRef?.sha256 === 'string' ? markdownRef.sha256.trim().toLowerCase() : '';
    if (
        String(ledger.audit_status || '').trim().toUpperCase() !== 'PASS'
        || String(verification?.status || '').trim().toUpperCase() !== 'VERIFIED'
        || !/^[0-9a-f]{64}$/u.test(expectedJsonSha256)
        || !/^[0-9a-f]{64}$/u.test(expectedMarkdownSha256)
    ) {
        return false;
    }
    const actualJson = fs.readFileSync(closeoutJsonPath, 'utf8');
    const actualMarkdown = fs.readFileSync(closeoutMarkdownPath, 'utf8');
    if (
        sha256Text(actualJson) !== expectedJsonSha256
        || sha256Text(actualMarkdown) !== expectedMarkdownSha256
        || actualJson !== `${JSON.stringify(closeout, null, 2)}\n`
    ) {
        return false;
    }
    const implementationSummary = isPlainRecord(closeout.implementation_summary) ? closeout.implementation_summary : null;
    const ledgerScope = isPlainRecord(ledger.scope) ? ledger.scope : null;
    const cycleBinding = isPlainRecord(closeout.cycle_binding) ? closeout.cycle_binding : null;
    const timing = isPlainRecord(ledger.timing) ? ledger.timing : null;
    return !!implementationSummary
        && !!ledgerScope
        && ledgerScope.changed_files_sha256 === implementationSummary.changed_files_sha256
        && ledgerScope.scope_content_sha256 === implementationSummary.scope_content_sha256
        && ledgerScope.scope_sha256 === implementationSummary.scope_sha256
        && timing?.compile_gate_timestamp === cycleBinding?.compile_gate_timestamp;
}

export function readReadyFinalReportSummary(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    summary: TaskAuditSummaryResult,
    eventsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'))
): NextStepFinalReportSummary | null {
    const closeoutJsonPath = path.join(reviewsRoot, `${taskId}-final-closeout.json`);
    const closeoutMarkdownPath = path.join(reviewsRoot, `${taskId}-final-closeout.md`);
    const finalUserReportPath = path.join(reviewsRoot, `${taskId}-final-user-report.md`);
    if (!fileExists(closeoutJsonPath) || !fileExists(closeoutMarkdownPath) || !fileExists(finalUserReportPath)) {
        return null;
    }

    const closeout = safeReadJson(closeoutJsonPath);
    if (!isPlainRecord(closeout)) {
        return null;
    }
    if (String(closeout.task_id || '').trim() !== taskId) {
        return null;
    }
    if (String(closeout.status || '').trim().toUpperCase() !== 'READY') {
        return null;
    }
    if (!finalCloseoutMatchesCurrentCycle(summary.final_closeout.cycle_binding, closeout, repoRoot, reviewsRoot, taskId, eventsRoot)) {
        return null;
    }
    const generatedUtc = typeof closeout.generated_utc === 'string' ? closeout.generated_utc : '';
    const expectedCloseout = { ...summary.final_closeout, generated_utc: generatedUtc, artifact_state: 'MATERIALIZED' as const };
    const expectedAttestation = expectedCloseout.review_integrity_attestation;
    const expectedJson = `${JSON.stringify(expectedCloseout, null, 2)}\n`;
    const exactCurrentSummaryMatch = !!generatedUtc
        && !!expectedAttestation
        && expectedAttestation.completion_allowed === true
        && fs.readFileSync(closeoutJsonPath, 'utf8') === expectedJson;
    const materializedLedgerMatch = !exactCurrentSummaryMatch
        && finalCloseoutMatchesMaterializedLedger(
            reviewsRoot,
            taskId,
            closeout,
            closeoutJsonPath,
            closeoutMarkdownPath
        );
    if (!exactCurrentSummaryMatch && !materializedLedgerMatch) {
        return null;
    }
    const canonicalCloseout = exactCurrentSummaryMatch
        ? expectedCloseout
        : closeout as unknown as TaskAuditSummaryResult['final_closeout'];
    const expectedMarkdown = `${formatFinalCloseoutMarkdown(canonicalCloseout)}\n`;
    if (fs.readFileSync(closeoutMarkdownPath, 'utf8') !== expectedMarkdown) {
        return null;
    }
    const expectedFinalUserReport = `${formatFinalUserReport(canonicalCloseout)}\n`;
    const actualFinalUserReport = fs.readFileSync(finalUserReportPath, 'utf8');
    if (actualFinalUserReport !== expectedFinalUserReport) {
        return null;
    }

    return {
        closeout_json_path: toRepoDisplayPath(repoRoot, closeoutJsonPath),
        closeout_markdown_path: toRepoDisplayPath(repoRoot, closeoutMarkdownPath),
        final_user_report_path: toRepoDisplayPath(repoRoot, finalUserReportPath),
        final_user_report_body: actualFinalUserReport,
        final_user_report_sha256: sha256Text(actualFinalUserReport),
        required_order: buildFinalReportOrder(summary),
        commit_command_suggestion: summary.final_report_contract.commit_command_suggestion,
        commit_question: summary.final_report_contract.commit_question
    };
}

export function readPostDoneWorkspaceDriftDecision(
    repoRoot: string,
    preflight: Record<string, unknown> | null,
    docImpactPath: string,
    finalCloseoutJsonPath: string,
    workspaceSnapshotRequest?: WorkspaceSnapshotRequest
): PostDoneWorkspaceDriftDecision {
    const authenticatedWorkspaceSnapshotRequest = workspaceSnapshotRequest
        ? resolveWorkspaceSnapshotRequest(repoRoot, workspaceSnapshotRequest)
        : undefined;
    if (!preflight) {
        return { blocked: false, reason: 'No preflight is available for post-DONE drift comparison.' };
    }

    let currentSnapshot: WorkspaceSnapshot & { cache_hit: boolean };
    try {
        currentSnapshot = authenticatedWorkspaceSnapshotRequest
            ? authenticatedWorkspaceSnapshotRequest.read('git_auto', true, [])
            : getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, [], {
                noCache: true,
                readOnly: true
            });
    } catch (error) {
        const gitMetadataPath = path.join(repoRoot, '.git');
        if (!fs.existsSync(gitMetadataPath)) {
            return { blocked: false, reason: 'Workspace inspection is unavailable outside a git worktree.' };
        }
        return {
            blocked: true,
            reason:
                'Unable to inspect tracked post-DONE workspace drift for the completed task closeout: ' +
                `${error instanceof Error ? error.message : String(error)}. ` +
                'Do not report the task as DONE until workspace drift can be inspected or the task is explicitly reopened/reset.'
        };
    }
    const auditedChangedFiles = getPostDoneAuditedChangedFiles(preflight, docImpactPath);
    const currentChangedFiles = currentSnapshot.changed_files.map((entry) => normalizePath(entry)).filter(Boolean);
    const unexpectedWorkspace = getUnexpectedPostDoneWorkspaceFiles(
        repoRoot,
        currentChangedFiles,
        auditedChangedFiles,
        preflight
    );
    if (unexpectedWorkspace.protectedBaselineIntegrityError || unexpectedWorkspace.unexpectedFiles.length > 0) {
        const details = unexpectedWorkspace.protectedBaselineIntegrityError
            ? 'dirty workspace protected-baseline authentication failed' + (
                unexpectedWorkspace.unexpectedFiles.length > 0
                    ? ` for ${describePathList(unexpectedWorkspace.unexpectedFiles)}`
                    : ''
            )
            : describePathList(unexpectedWorkspace.unexpectedFiles);
        return {
            blocked: true,
            reason:
                `Post-DONE workspace drift detected outside completed scope ${describePathList(auditedChangedFiles)}: ` +
                `${details}. ` +
                'Do not reopen stale lifecycle gates automatically. Commit or isolate the already-completed task diff, or explicitly reopen/reset the task before running classify, compile, review, full-suite, or completion gates again.'
        };
    }
    const stagedScopeDecision = evaluateStagedPostDoneAuditedScope({
        repoRoot,
        auditedFiles: auditedChangedFiles,
        currentChangedFiles,
        finalCloseoutJsonPath,
        preflight,
        workspaceSnapshotRequest: authenticatedWorkspaceSnapshotRequest
    });
    if (stagedScopeDecision) {
        return { blocked: stagedScopeDecision.blocked, reason: stagedScopeDecision.reason };
    }
    const closeout = safeReadJson(finalCloseoutJsonPath);
    const implementationSummary = isPlainRecord(closeout?.implementation_summary) ? closeout.implementation_summary : null;
    const expectedAuditedScopeContentSha256 = normalizeSha256(implementationSummary?.scope_content_sha256);
    const expectedAuditedChangedFilesSha256 = normalizeSha256(implementationSummary?.changed_files_sha256);
    if (auditedChangedFiles.length > 0 && (!expectedAuditedScopeContentSha256 || !expectedAuditedChangedFilesSha256)) {
        return {
            blocked: true,
            reason:
                `Materialized final closeout is missing valid audited scope hashes for ${describePathList(auditedChangedFiles)}. ` +
                'Both changed_files_sha256 and scope_content_sha256 must be valid SHA-256 values before the task can remain DONE.'
        };
    }
    if (expectedAuditedScopeContentSha256 && expectedAuditedChangedFilesSha256 && auditedChangedFiles.length > 0) {
        let currentAuditedScope: ReturnType<typeof readPostDoneAuditedScopeFingerprint>;
        try {
            currentAuditedScope = readPostDoneAuditedScopeFingerprint(
                repoRoot,
                auditedChangedFiles,
                implementationSummary,
                authenticatedWorkspaceSnapshotRequest
            );
        } catch (error) {
            return {
                blocked: true,
                reason:
                    'Unable to inspect audited post-DONE closeout content: ' +
                    `${error instanceof Error ? error.message : String(error)}. ` +
                    'Do not report the task as DONE until workspace drift can be inspected or the task is explicitly reopened/reset.'
            };
        }
        const auditedViolations = [
            currentAuditedScope.scope_content_sha256 !== expectedAuditedScopeContentSha256
                ? `audited scope_content_sha256=${expectedAuditedScopeContentSha256} differs from current audited scope_content_sha256=${currentAuditedScope.scope_content_sha256}`
                : '',
            currentAuditedScope.changed_files_sha256 !== expectedAuditedChangedFilesSha256
                ? `audited changed_files_sha256=${expectedAuditedChangedFilesSha256} differs from current audited changed_files_sha256=${currentAuditedScope.changed_files_sha256}`
                : ''
        ].filter(Boolean);
        if (auditedViolations.length === 0) {
            return { blocked: false, reason: 'Audited final closeout scope still matches the current workspace after DONE.' };
        }
        return {
            blocked: true,
            reason:
                `Tracked post-DONE workspace drift detected in audited completed scope ${describePathList(auditedChangedFiles)}: ` +
                `${auditedViolations.join('; ')}. ` +
                'Do not reopen stale lifecycle gates automatically. Commit or isolate the already-completed task diff, or explicitly reopen/reset the task before running classify, compile, review, full-suite, or completion gates again.'
        };
    }

    if (currentSnapshot.changed_files.length === 0) {
        return { blocked: false, reason: 'Workspace is clean after DONE.' };
    }

    const readiness = readPreflightWorkspaceReadiness(repoRoot, preflight, {
        docImpactPath,
        allowDocsOnlyDelta: false,
        workspaceSnapshotRequest: authenticatedWorkspaceSnapshotRequest
    });
    if (readiness.ready) {
        return { blocked: false, reason: readiness.reason };
    }

    return {
        blocked: true,
        reason:
            `Tracked post-DONE workspace drift detected in completed scope ${describePathList(getPreflightChangedFiles(preflight))}: ${readiness.reason} ` +
            'Do not reopen stale lifecycle gates automatically. Commit or isolate the already-completed task diff, or explicitly reopen/reset the task before running classify, compile, review, full-suite, or completion gates again.'
    };
}
