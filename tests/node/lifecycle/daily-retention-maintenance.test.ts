import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    runDailyRetentionMaintenance,
    resolveDailyRetentionMaintenanceReportPath
} from '../../../src/lifecycle/daily-retention-maintenance';
import {
    listBackups,
    DEFAULT_BACKUP_KEEP_LATEST
} from '../../../src/lifecycle/backups';
import { writeRollbackRecords } from '../../../src/lifecycle/common';
import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import { buildDefaultWorkflowConfig, type WorkflowConfigData } from '../../../src/core/workflow-config';

function makeWorkspace(prefix: string): { targetRoot: string; bundleRoot: string; cleanup: () => void } {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    return {
        targetRoot,
        bundleRoot,
        cleanup: () => fs.rmSync(targetRoot, { recursive: true, force: true })
    };
}

function writeRuntimeRetentionConfig(
    bundleRoot: string,
    options: {
        enabled: boolean;
        dryRun?: boolean;
        maxTasksPerRun?: number;
        eligibleOlderThanDays?: number;
        keepLatestTasks?: number;
        purgeRequireConfirm?: boolean;
        omitDryRun?: boolean;
    }
): void {
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const dailyMaintenance: Record<string, unknown> = {
        enabled: options.enabled,
        max_tasks_per_run: options.maxTasksPerRun ?? 25,
        eligible_older_than_days: options.eligibleOlderThanDays ?? 30,
        keep_latest_tasks: options.keepLatestTasks ?? 0,
        dry_run: options.dryRun ?? false
    };
    if (options.omitDryRun) {
        delete dailyMaintenance.dry_run;
    }
    fs.writeFileSync(path.join(configDir, 'runtime-retention.json'), JSON.stringify({
        version: 1,
        active_tasks: {
            protect_runtime_grace_days: 7,
            protect_current_cycle_artifacts: true
        },
        healthy_done: {
            compact_after_days: 30,
            require_ledger: true,
            retain_task_events_until_ledger_verified: true
        },
        problem_tasks: {
            compress_after_days: 30,
            preserve_detailed_evidence: true
        },
        purge: {
            require_confirm: options.purgeRequireConfirm ?? true
        },
        daily_maintenance: dailyMaintenance
    }, null, 2) + '\n', 'utf8');
}

function writeWorkflowConfig(
    bundleRoot: string,
    configure: (config: WorkflowConfigData) => void
): void {
    const config = buildDefaultWorkflowConfig();
    configure(config);
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function seedRollbackSnapshot(targetRoot: string, name: string): string {
    const snapshotPath = path.join(
        targetRoot,
        'garda-agent-orchestrator',
        'runtime',
        'update-rollbacks',
        name
    );
    const versionPath = path.join(snapshotPath, 'garda-agent-orchestrator', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, `${name}\n`, 'utf8');
    writeRollbackRecords(snapshotPath, [
        {
            relativePath: 'garda-agent-orchestrator/VERSION',
            existed: true,
            pathType: 'file'
        }
    ]);
    return snapshotPath;
}

function createCorruptBackupInventoryRoot(bundleRoot: string): string {
    const snapshotsRoot = path.join(bundleRoot, 'runtime', 'update-rollbacks');
    fs.mkdirSync(path.dirname(snapshotsRoot), { recursive: true });
    fs.writeFileSync(snapshotsRoot, 'not a directory', 'utf8');
    return snapshotsRoot;
}

function createOldRuntimeTmpEntry(bundleRoot: string): string {
    const entryPath = path.join(bundleRoot, 'runtime', 'tmp', 'old-entry');
    fs.mkdirSync(entryPath, { recursive: true });
    fs.writeFileSync(path.join(entryPath, 'scratch.txt'), 'scratch', 'utf8');
    const old = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(path.join(entryPath, 'scratch.txt'), old, old);
    fs.utimesSync(entryPath, old, old);
    return entryPath;
}

function writeVerifiedLedger(bundleRoot: string, taskId: string): void {
    const ledgerDir = path.join(bundleRoot, 'runtime', 'task-ledger');
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, `${taskId}.json`), JSON.stringify({
        schema_version: 1,
        event_source: 'task-history-ledger',
        task_id: taskId,
        verification: {
            status: 'VERIFIED',
            issues: []
        }
    }, null, 2) + '\n', 'utf8');
}

function writeTimelineSummary(bundleRoot: string, taskId: string): void {
    const eventsDir = path.join(bundleRoot, 'runtime', 'task-events');
    const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
    const stat = fs.statSync(timelinePath);
    const summaryPath = path.join(eventsDir, '.timeline-summary.json');
    let entries: Record<string, unknown> = {};
    if (fs.existsSync(summaryPath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as { entries?: Record<string, unknown> };
            entries = existing.entries ?? {};
        } catch {
            entries = {};
        }
    }
    entries[taskId] = {
        task_id: taskId,
        file_size_bytes: stat.size,
        file_mtime_ms: Math.floor(stat.mtimeMs),
        code_changed: false,
        completeness_status: 'COMPLETE',
        events_found: ['TASK_MODE_ENTERED', 'STATUS_CHANGED', 'COMPLETION_GATE_PASSED'],
        events_missing: [],
        completeness_violations: [],
        integrity_status: 'PASS',
        events_scanned: 3,
        integrity_event_count: 3,
        integrity_violations: []
    };
    fs.writeFileSync(path.join(eventsDir, '.timeline-summary.json'), JSON.stringify({
        version: 2,
        updated_at_utc: '2026-05-21T10:00:00.000Z',
        entries
    }, null, 2) + '\n', 'utf8');
}

function createHealthyDoneRetentionCandidate(
    bundleRoot: string,
    taskId: string,
    artifactTime: Date = new Date('2026-01-01T00:00:00.000Z')
): { finalCloseoutPath: string; timelinePath: string } {
    const reviewsDir = path.join(bundleRoot, 'runtime', 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    const finalCloseoutPath = path.join(reviewsDir, `${taskId}-final-closeout.json`);
    fs.writeFileSync(finalCloseoutPath, JSON.stringify({ task_id: taskId, status: 'READY' }), 'utf8');

    appendTaskEvent(bundleRoot, taskId, 'TASK_MODE_ENTERED', 'PASS', 'Task mode entered.', {}, { passThru: true });
    appendTaskEvent(bundleRoot, taskId, 'STATUS_CHANGED', 'PASS', 'Task status changed.', {
        previous_status: 'IN_REVIEW',
        new_status: 'DONE'
    }, { passThru: true });
    appendTaskEvent(bundleRoot, taskId, 'COMPLETION_GATE_PASSED', 'PASS', 'Completion gate passed.', {}, { passThru: true });
    writeTimelineSummary(bundleRoot, taskId);
    writeVerifiedLedger(bundleRoot, taskId);

    const timelinePath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
    const ledgerPath = path.join(bundleRoot, 'runtime', 'task-ledger', `${taskId}.json`);
    for (const candidatePath of [finalCloseoutPath, timelinePath, ledgerPath]) {
        fs.utimesSync(candidatePath, artifactTime, artifactTime);
    }
    return { finalCloseoutPath, timelinePath };
}

describe('daily retention maintenance', () => {
    it('runs confirmed maintenance once per local day and then skips by sentinel', () => {
        const workspace = makeWorkspace('daily-retention-once-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, { enabled: true, purgeRequireConfirm: false });
            const staleEntry = createOldRuntimeTmpEntry(workspace.bundleRoot);
            const now = new Date('2026-05-21T10:00:00.000Z');

            const first = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now
            });

            assert.equal(first.status, 'SUCCESS');
            assert.equal(first.lock_acquired, true);
            assert.equal(fs.existsSync(staleEntry), true, 'daily retention must not run broad tmp cleanup');
            assert.equal(fs.existsSync(resolveDailyRetentionMaintenanceReportPath(workspace.bundleRoot, first.local_date)), true);
            assert.equal(first.gc_result?.removed_count ?? 0, 0);

            const second = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now
            });
            assert.equal(second.status, 'SKIPPED_ALREADY_RAN');
            assert.equal(second.lock_acquired, false);
        } finally {
            workspace.cleanup();
        }
    });

    it('honors disabled and dry-run daily maintenance policy', () => {
        const disabledWorkspace = makeWorkspace('daily-retention-disabled-');
        try {
            writeRuntimeRetentionConfig(disabledWorkspace.bundleRoot, { enabled: false });
            const disabled = runDailyRetentionMaintenance({
                targetRoot: disabledWorkspace.targetRoot,
                bundleRoot: disabledWorkspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });
            assert.equal(disabled.status, 'DISABLED');
            assert.equal(fs.existsSync(disabled.report_path), false);
        } finally {
            disabledWorkspace.cleanup();
        }

        const dryRunWorkspace = makeWorkspace('daily-retention-dry-run-');
        try {
            writeRuntimeRetentionConfig(dryRunWorkspace.bundleRoot, { enabled: true, dryRun: true });
            const staleEntry = createOldRuntimeTmpEntry(dryRunWorkspace.bundleRoot);
            const dryRun = runDailyRetentionMaintenance({
                targetRoot: dryRunWorkspace.targetRoot,
                bundleRoot: dryRunWorkspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });
            assert.equal(dryRun.status, 'DRY_RUN');
            assert.equal(dryRun.dry_run, true);
            assert.equal(fs.existsSync(staleEntry), true);
            assert.equal(dryRun.gc_result?.skipped_count ?? 0, 0);
        } finally {
            dryRunWorkspace.cleanup();
        }
    });

    it('keeps scheduled auto-backups disabled by default while daily maintenance reports state', () => {
        const workspace = makeWorkspace('daily-auto-backup-disabled-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, { enabled: true, purgeRequireConfirm: false });

            const result = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(result.status, 'SUCCESS');
            assert.equal(result.scheduled_backup?.status, 'DISABLED');
            assert.equal(result.scheduled_backup?.enabled, false);
            assert.equal(result.scheduled_backup?.keep_latest, DEFAULT_BACKUP_KEEP_LATEST);
            assert.equal(listBackups(workspace.targetRoot).length, 0);
        } finally {
            workspace.cleanup();
        }
    });

    it('creates due scheduled auto-backups once per local day and prunes by keepLatest', () => {
        const workspace = makeWorkspace('daily-auto-backup-due-');
        try {
            fs.writeFileSync(path.join(workspace.bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
            writeRuntimeRetentionConfig(workspace.bundleRoot, { enabled: true, purgeRequireConfirm: false });
            writeWorkflowConfig(workspace.bundleRoot, (config) => {
                config.auto_backup.enabled = true;
                config.auto_backup.interval_days = 1;
                config.auto_backup.keep_latest = 2;
            });
            seedRollbackSnapshot(workspace.targetRoot, 'scheduled-20260518-010000-000');
            seedRollbackSnapshot(workspace.targetRoot, 'scheduled-20260519-010000-000');

            const first = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(first.status, 'SUCCESS');
            assert.equal(first.scheduled_backup?.status, 'SUCCESS');
            assert.equal(first.scheduled_backup?.created_backup?.reason, 'scheduled');
            assert.equal(
                first.scheduled_backup?.latest_scheduled_backup_id,
                first.scheduled_backup?.created_backup?.id
            );
            assert.equal(
                first.scheduled_backup?.latest_scheduled_backup_created_at,
                first.scheduled_backup?.created_backup?.createdAt
            );
            assert.equal(
                first.scheduled_backup?.next_due_at,
                new Date(Date.parse(first.scheduled_backup?.created_backup?.createdAt ?? '') + 24 * 60 * 60 * 1000).toISOString()
            );
            assert.equal(first.scheduled_backup?.retention_result?.candidate_count, 1);
            assert.equal(listBackups(workspace.targetRoot).length, 2);
            assert.equal(
                listBackups(workspace.targetRoot).some((backup) => backup.id === 'scheduled-20260518-010000-000'),
                false,
                'oldest scheduled backup should be pruned by configured keepLatest'
            );

            const second = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T11:00:00.000Z')
            });
            assert.equal(second.scheduled_backup?.status, 'SKIPPED_ALREADY_RAN');
        } finally {
            workspace.cleanup();
        }
    });

    it('does not read backup inventory when scheduled auto-backups are disabled', () => {
        const workspace = makeWorkspace('daily-auto-backup-disabled-corrupt-inventory-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, { enabled: true, purgeRequireConfirm: false });
            createCorruptBackupInventoryRoot(workspace.bundleRoot);

            const result = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(result.status, 'SUCCESS');
            assert.equal(result.scheduled_backup?.status, 'DISABLED');
            assert.equal(result.scheduled_backup?.error, null);
        } finally {
            workspace.cleanup();
        }
    });

    it('allows same-day scheduled auto-backup after the feature is enabled', () => {
        const workspace = makeWorkspace('daily-auto-backup-same-day-enable-');
        try {
            fs.writeFileSync(path.join(workspace.bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
            writeRuntimeRetentionConfig(workspace.bundleRoot, { enabled: false });
            const now = new Date('2026-05-21T10:00:00.000Z');

            const disabled = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now
            });
            assert.equal(disabled.status, 'DISABLED');
            assert.equal(disabled.scheduled_backup?.status, 'DISABLED');

            writeWorkflowConfig(workspace.bundleRoot, (config) => {
                config.auto_backup.enabled = true;
                config.auto_backup.interval_days = 1;
                config.auto_backup.keep_latest = 10;
            });

            const enabled = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T11:00:00.000Z')
            });
            assert.equal(enabled.status, 'DISABLED');
            assert.equal(enabled.scheduled_backup?.status, 'SUCCESS');
            assert.equal(enabled.scheduled_backup?.created_backup?.reason, 'scheduled');
        } finally {
            workspace.cleanup();
        }
    });

    it('audits scheduled auto-backup inventory failures without throwing from daily maintenance', () => {
        const workspace = makeWorkspace('daily-auto-backup-corrupt-inventory-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, { enabled: false });
            writeWorkflowConfig(workspace.bundleRoot, (config) => {
                config.auto_backup.enabled = true;
            });
            createCorruptBackupInventoryRoot(workspace.bundleRoot);

            const result = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(result.status, 'DISABLED');
            assert.equal(result.scheduled_backup?.status, 'FAILED');
            assert.match(result.scheduled_backup?.error ?? '', /ENOTDIR|not a directory|directory/i);
            assert.equal(fs.existsSync(result.scheduled_backup?.report_path ?? ''), true);
        } finally {
            workspace.cleanup();
        }
    });

    it('skips scheduled auto-backup when the latest scheduled backup is not due', () => {
        const workspace = makeWorkspace('daily-auto-backup-not-due-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, { enabled: false });
            writeWorkflowConfig(workspace.bundleRoot, (config) => {
                config.auto_backup.enabled = true;
                config.auto_backup.interval_days = 7;
                config.auto_backup.keep_latest = 10;
            });
            seedRollbackSnapshot(workspace.targetRoot, 'scheduled-20260520-010000-000');

            const result = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(result.status, 'DISABLED');
            assert.equal(result.scheduled_backup?.status, 'SKIPPED_NOT_DUE');
            assert.equal(result.scheduled_backup?.latest_scheduled_backup_id, 'scheduled-20260520-010000-000');
            assert.equal(listBackups(workspace.targetRoot).length, 1);
        } finally {
            workspace.cleanup();
        }
    });

    it('forces dry-run when purge confirmation is still required', () => {
        const workspace = makeWorkspace('daily-retention-confirm-required-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, {
                enabled: true,
                dryRun: false,
                purgeRequireConfirm: true
            });
            const staleEntry = createOldRuntimeTmpEntry(workspace.bundleRoot);

            const result = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(result.status, 'DRY_RUN');
            assert.equal(result.dry_run, true);
            assert.equal(fs.existsSync(staleEntry), true);
            assert.equal(result.gc_result?.skipped_count ?? 0, 0);
        } finally {
            workspace.cleanup();
        }
    });

    it('treats legacy missing daily dry-run as dry-run even when purge confirm is disabled', () => {
        const workspace = makeWorkspace('daily-retention-legacy-dry-run-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, {
                enabled: true,
                purgeRequireConfirm: false,
                omitDryRun: true
            });
            const staleEntry = createOldRuntimeTmpEntry(workspace.bundleRoot);

            const result = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(result.status, 'DRY_RUN');
            assert.equal(result.dry_run, true);
            assert.equal(fs.existsSync(staleEntry), true);
            assert.equal(result.gc_result?.skipped_count ?? 0, 0);
        } finally {
            workspace.cleanup();
        }
    });

    it('does not mark partial gc maintenance as a successful daily sentinel', () => {
        const workspace = makeWorkspace('daily-retention-partial-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, { enabled: true, purgeRequireConfirm: false });
            const now = new Date('2026-05-21T10:00:00.000Z');
            const mutableCleanup = require('../../../src/lifecycle/cleanup/cleanup-orchestration') as {
                runGc: typeof import('../../../src/lifecycle/cleanup/cleanup-orchestration').runGc;
            };
            const originalRunGc = mutableCleanup.runGc;
            mutableCleanup.runGc = ((options) => {
                const result = originalRunGc(options);
                return {
                    ...result,
                    result: 'PARTIAL',
                    errors: [
                        ...result.errors,
                        { path: 'runtime/reviews/T-900.json', message: 'forced partial gc result' }
                    ]
                };
            }) as typeof mutableCleanup.runGc;

            try {
                const first = runDailyRetentionMaintenance({
                    targetRoot: workspace.targetRoot,
                    bundleRoot: workspace.bundleRoot,
                    now
                });

                assert.equal(first.status, 'FAILED');
                assert.equal(first.lock_acquired, true);
                assert.equal(first.gc_result?.result, 'PARTIAL');
                assert.ok((first.gc_result?.error_count ?? 0) > 0);

                const second = runDailyRetentionMaintenance({
                    targetRoot: workspace.targetRoot,
                    bundleRoot: workspace.bundleRoot,
                    now
                });
                assert.equal(second.status, 'FAILED');
                assert.equal(second.skipped_reason, null);
                assert.equal(second.lock_acquired, true);
            } finally {
                mutableCleanup.runGc = originalRunGc;
            }
        } finally {
            workspace.cleanup();
        }
    });

    it('bounds selected runtime-retention tasks during daily maintenance', () => {
        const workspace = makeWorkspace('daily-retention-task-limit-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, {
                enabled: true,
                dryRun: false,
                maxTasksPerRun: 1,
                purgeRequireConfirm: false
            });
            const selectedCandidate = createHealthyDoneRetentionCandidate(workspace.bundleRoot, 'T-700');
            const deferredCandidate = createHealthyDoneRetentionCandidate(workspace.bundleRoot, 'T-701');

            const result = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(result.status, 'SUCCESS');
            assert.equal(result.gc_result?.selected_task_limit, 1);
            assert.equal(result.gc_result?.eligible_now_count, 2);
            assert.ok((result.gc_result?.removed_count ?? 0) > 0);
            assert.equal(fs.existsSync(selectedCandidate.finalCloseoutPath), false,
                'selected daily retention task should compact heavy review evidence');
            assert.equal(fs.existsSync(deferredCandidate.finalCloseoutPath), true,
                'task outside max_tasks_per_run window must remain untouched for a later pass');
            assert.equal(fs.existsSync(deferredCandidate.timelinePath), true,
                'daily maintenance must not compact task-event evidence outside the selected task set');
        } finally {
            workspace.cleanup();
        }
    });

    it('applies daily runtime-retention age and keep-latest selection before deleting artifacts', () => {
        const workspace = makeWorkspace('daily-retention-selection-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, {
                enabled: true,
                dryRun: false,
                maxTasksPerRun: 25,
                eligibleOlderThanDays: 30,
                keepLatestTasks: 2,
                purgeRequireConfirm: false
            });
            const youngCandidate = createHealthyDoneRetentionCandidate(
                workspace.bundleRoot,
                'T-100',
                new Date('2026-05-15T00:00:00.000Z')
            );
            const protectedLatestCandidate = createHealthyDoneRetentionCandidate(
                workspace.bundleRoot,
                'T-010',
                new Date('2026-04-15T00:00:00.000Z')
            );
            const selectedOldCandidate = createHealthyDoneRetentionCandidate(
                workspace.bundleRoot,
                'T-090',
                new Date('2026-01-01T00:00:00.000Z')
            );

            const result = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(result.status, 'SUCCESS');
            assert.equal(result.eligible_older_than_days, 30);
            assert.equal(result.keep_latest_tasks, 2);
            assert.equal(result.gc_result?.eligible_now_count, 1);
            assert.equal(fs.existsSync(selectedOldCandidate.timelinePath), false,
                'oldest eligible task should be compacted');
            assert.equal(fs.existsSync(protectedLatestCandidate.timelinePath), true,
                'latest eligible task should be retained even when its id sorts first');
            assert.equal(fs.existsSync(youngCandidate.timelinePath), true,
                'task younger than eligible_older_than_days must stay outside daily deletion');
        } finally {
            workspace.cleanup();
        }
    });

    it('uses the maintenance clock for daily age-based runtime-retention selection', () => {
        const workspace = makeWorkspace('daily-retention-injected-now-');
        try {
            writeRuntimeRetentionConfig(workspace.bundleRoot, {
                enabled: true,
                dryRun: false,
                maxTasksPerRun: 25,
                eligibleOlderThanDays: 30,
                purgeRequireConfirm: false
            });
            const candidate = createHealthyDoneRetentionCandidate(
                workspace.bundleRoot,
                'T-120',
                new Date('2026-05-01T00:00:00.000Z')
            );

            const result = runDailyRetentionMaintenance({
                targetRoot: workspace.targetRoot,
                bundleRoot: workspace.bundleRoot,
                now: new Date('2026-05-21T10:00:00.000Z')
            });

            assert.equal(result.status, 'SUCCESS');
            assert.equal(result.gc_result?.eligible_now_count, 0);
            assert.equal(fs.existsSync(candidate.timelinePath), true,
                'daily maintenance must not use wall-clock time when evaluating age filters');
        } finally {
            workspace.cleanup();
        }
    });
});
