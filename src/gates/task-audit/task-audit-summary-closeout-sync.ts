import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../../core/filesystem';
import { redactSensitiveData } from '../../core/redaction';
import {
    buildTaskHistoryLedger,
    resolveTaskHistoryLedgerPath
} from '../../gate-runtime/task-history-ledger';
import { cleanupTerminalReviewTempOutputs } from '../../cli/gate-cli/gates-artifacts';
import { runDailyRetentionMaintenance } from '../../lifecycle/daily-retention-maintenance';
import { updateEvidenceArtifactState } from './task-audit-summary-collectors';
import { formatFinalCloseoutMarkdown, formatFinalUserReport } from './task-audit-summary-renderers';
import { type TaskAuditSummaryResult } from './task-audit-summary';

export function runFinalCloseoutMaintenance(options: { repoRoot: string; bundleRoot: string; taskId: string }): void {
    cleanupTerminalReviewTempOutputs(options.repoRoot, options.taskId);
    runDailyRetentionMaintenance({ targetRoot: options.repoRoot, bundleRoot: options.bundleRoot });
}

export function synchronizeFinalCloseoutArtifacts(
    summary: TaskAuditSummaryResult,
    options: { deferTerminalCleanup?: boolean } = {}
): TaskAuditSummaryResult {
    const jsonPath = summary.final_closeout.artifact_paths.json;
    const markdownPath = summary.final_closeout.artifact_paths.markdown;
    const finalUserReportPath = summary.final_closeout.artifact_paths.final_user_report;
    const bundleRoot = path.dirname(path.dirname(path.dirname(jsonPath)));
    const ledgerPath = resolveTaskHistoryLedgerPath(bundleRoot, summary.task_id);

    if (summary.final_closeout.status === 'READY') {
        const closeout = redactSensitiveData({
            ...summary.final_closeout,
            artifact_state: 'MATERIALIZED' as const
        }) as typeof summary.final_closeout;
        writeFileAtomically(jsonPath, JSON.stringify(closeout, null, 2) + '\n', { encoding: 'utf8' });
        writeFileAtomically(markdownPath, formatFinalCloseoutMarkdown(closeout) + '\n', { encoding: 'utf8' });
        if (finalUserReportPath) {
            writeFileAtomically(finalUserReportPath, formatFinalUserReport(closeout) + '\n', { encoding: 'utf8' });
        }
        if (!options.deferTerminalCleanup) {
            runFinalCloseoutMaintenance({
                repoRoot: path.resolve(path.dirname(jsonPath), '..', '..', '..'),
                bundleRoot,
                taskId: summary.task_id
            });
        }
        summary.final_closeout = closeout;
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-json', jsonPath, true);
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-markdown', markdownPath, true);
        if (finalUserReportPath) {
            updateEvidenceArtifactState(summary.evidence, 'final-user-report', finalUserReportPath, true);
        }
    } else if (summary.point_in_time_snapshot.status === 'FINALIZATION_IN_FLIGHT') {
        const jsonExists = fs.existsSync(jsonPath);
        const markdownExists = fs.existsSync(markdownPath);
        const finalUserReportExists = finalUserReportPath ? fs.existsSync(finalUserReportPath) : false;
        summary.final_closeout = {
            ...summary.final_closeout,
            artifact_state: jsonExists || markdownExists || finalUserReportExists ? 'MATERIALIZED' : 'NOT_READY'
        };
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-json', jsonPath, jsonExists);
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-markdown', markdownPath, markdownExists);
        if (finalUserReportPath) {
            updateEvidenceArtifactState(summary.evidence, 'final-user-report', finalUserReportPath, finalUserReportExists);
        }
    } else if (summary.blockers.some((blocker) => blocker.gate === 'post-done-drift')) {
        const jsonExists = fs.existsSync(jsonPath);
        const markdownExists = fs.existsSync(markdownPath);
        const finalUserReportExists = finalUserReportPath ? fs.existsSync(finalUserReportPath) : false;
        summary.final_closeout = {
            ...summary.final_closeout,
            artifact_state: jsonExists || markdownExists || finalUserReportExists ? 'MATERIALIZED' : 'NOT_READY'
        };
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-json', jsonPath, jsonExists);
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-markdown', markdownPath, markdownExists);
        if (finalUserReportPath) {
            updateEvidenceArtifactState(summary.evidence, 'final-user-report', finalUserReportPath, finalUserReportExists);
        }
    } else {
        let removed = false;
        for (const artifactPath of [jsonPath, markdownPath, finalUserReportPath].filter(Boolean) as string[]) {
            if (fs.existsSync(artifactPath)) {
                fs.rmSync(artifactPath, { force: true });
                removed = true;
            }
        }
        summary.final_closeout = {
            ...summary.final_closeout,
            artifact_state: removed ? 'REMOVED' : 'NOT_READY'
        };
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-json', jsonPath, false);
        updateEvidenceArtifactState(summary.evidence, 'final-closeout-markdown', markdownPath, false);
        if (finalUserReportPath) {
            updateEvidenceArtifactState(summary.evidence, 'final-user-report', finalUserReportPath, false);
        }
    }

    if (summary.status !== 'INCOMPLETE') {
        fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
        const ledger = redactSensitiveData(buildTaskHistoryLedger(summary, path.dirname(bundleRoot))) as ReturnType<typeof buildTaskHistoryLedger>;
        writeFileAtomically(ledgerPath, JSON.stringify(ledger, null, 2) + '\n', { encoding: 'utf8' });
        updateEvidenceArtifactState(summary.evidence, 'task-ledger', ledgerPath, true);
    } else {
        if (fs.existsSync(ledgerPath)) {
            fs.rmSync(ledgerPath, { force: true });
        }
        updateEvidenceArtifactState(summary.evidence, 'task-ledger', ledgerPath, false);
    }
    return summary;
}
