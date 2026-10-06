import type { LocalUiLocalizedText } from '../ui-language-pack-loader';

export const CLEANUP_SETTING_TEXT_IDS = Object.freeze([
    'tab_intro',
    'daily_maintenance_enabled',
    'daily_maintenance_max_tasks_per_run',
    'eligible_older_than_days',
    'keep_latest_tasks',
    'include_problematic_tasks',
    'daily_maintenance_dry_run',
    'purge_require_confirm',
    'healthy_done_compact_after_days',
    'problem_tasks_compress_after_days',
    'manual_runtime_cleanup',
    'task_purge',
    'task_id',
    'purge_task_button',
    'run_preview',
    'run_apply',
    'cleanup_report',
    'cleanup_result',
    'report_preview_tasks',
    'report_eligible_now',
    'report_would_remove',
    'report_would_free',
    'report_removed',
    'report_freed',
    'value_true',
    'value_false'
] as const);

export type CleanupSettingTextId = typeof CLEANUP_SETTING_TEXT_IDS[number];

export function buildCleanupSettingTextCatalog(): Readonly<Record<CleanupSettingTextId, LocalUiLocalizedText>> {
    return Object.freeze({
        tab_intro: {
            description: 'Runtime retention policy in runtime-retention.json: scheduled maintenance thresholds, compaction rules, and guarded manual cleanup actions.'
        },
        daily_maintenance_enabled: {
            label: 'Daily maintenance',
            description: 'Turns scheduled daily maintenance on or off. When enabled, the orchestrator can process a limited batch of eligible tasks on a schedule without manual intervention.'
        },
        daily_maintenance_max_tasks_per_run: {
            label: 'Max tasks per maintenance run',
            description: 'Upper bound on how many eligible tasks daily maintenance processes in a single run. Limits blast radius if thresholds are misconfigured.'
        },
        eligible_older_than_days: {
            label: 'Delete tasks older than (days)',
            description: 'Manual cleanup selects task runtime artifacts older than this many days. Active tasks and newer tasks stay protected.'
        },
        keep_latest_tasks: {
            label: 'Keep at least newest tasks (count)',
            description: 'Always preserve at least this many most-recent tasks even if they are older than the age threshold. Set 0 to rely only on age and active-task protection.'
        },
        include_problematic_tasks: {
            label: 'Also delete problematic tasks'
        },
        daily_maintenance_dry_run: {
            label: 'Preview daily cleanup',
            description: 'Off by default in new installations: daily maintenance applies retention-approved cleanup. Turn on to preview candidates without deleting or compressing artifacts. Existing preview choices are preserved. The confirmation safeguard below also forces preview when enabled.'
        },
        purge_require_confirm: {
            label: 'Automatic cleanup confirmation safeguard',
            description: 'Off by default in new installations. Turn on to force scheduled cleanup into preview even when preview mode is off. Manual CLI cleanup still requires --confirm. Manual UI cleanup and task-artifact cleanup always require their own typed confirmation phrases.'
        },
        healthy_done_compact_after_days: {
            label: 'Compress healthy DONE after (days)',
            description: 'After this many days, successfully completed (DONE) tasks may be compressed to ledger-only history once ledger evidence is verified.'
        },
        problem_tasks_compress_after_days: {
            label: 'Compress problem tasks after (days)',
            description: 'After this many days, failed or stuck tasks may have heavy forensic artifacts compressed while keeping recovery-readable evidence.'
        },
        manual_runtime_cleanup: {
            label: 'Manual runtime cleanup',
            description: 'Purges task-owned runtime artifacts for non-active tasks selected by the age and keep-latest controls in this row. Preview is a dry-run report; Run cleanup removes the selected task artifacts, repairs shared indexes once, and requires typed confirmation.'
        },
        task_purge: {
            label: 'Task runtime artifact cleanup',
            description: 'Removes runtime artifacts owned by one task ID and repairs shared indexes. It does not remove whole shared files; active-task protection still applies on the server.'
        },
        task_id: {
            label: 'Task ID'
        },
        purge_task_button: {
            label: 'Clean task runtime artifacts'
        },
        run_preview: {
            label: 'Preview calculation'
        },
        run_apply: {
            label: 'Run cleanup'
        },
        cleanup_report: {
            label: 'Cleanup report'
        },
        cleanup_result: {
            label: 'Cleanup result'
        },
        report_preview_tasks: {
            label: 'Preview candidates'
        },
        report_eligible_now: {
            label: 'Eligible now'
        },
        report_would_remove: {
            label: 'Would remove'
        },
        report_would_free: {
            label: 'Would free'
        },
        report_removed: {
            label: 'Removed'
        },
        report_freed: {
            label: 'Freed'
        },
        value_true: {
            label: 'true — enabled'
        },
        value_false: {
            label: 'false — disabled'
        }
    });
}

export function listCleanupSettingTextCatalogIds(
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildCleanupSettingTextCatalog()
): string[] {
    return Object.keys(catalog).sort();
}
