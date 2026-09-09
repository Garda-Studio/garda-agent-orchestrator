import {
    ALL_CLI_NAMES,
    PRIMARY_CLI_NAME,
    PRIMARY_PACKAGE_NAME,
    PRODUCT_ACRONYM,
    PRODUCT_ACRONYM_EXPANSION,
    PRODUCT_NAME
} from '../../core/constants';
import { buildDefaultRetentionPolicy, RETENTION_POLICY_DEFAULTS } from '../../lifecycle/cleanup';
import { formatLocalUiLanguageCliChoices } from '../../reports/ui/ui-i18n';
import { bold, cyan, dim, green, padRight, red, yellow } from './cli-colors';
import { COMMAND_SUMMARY } from './cli-constants';
import type { PackageJsonLike } from './cli-types';

export function printCommandSummary(): void {
    for (const line of buildCommandSummaryLines()) {
        console.log(line);
    }
}

export function buildCommandSummaryLines(): string[] {
    const lines = [bold('Available Commands')];
    for (const [name, description] of COMMAND_SUMMARY) {
        lines.push(`  ${cyan(padRight(name, 10))} ${dim(description)}`);
    }
    return lines;
}

export type GuardedCommandHelpName = 'agent-init' | 'skills' | 'review-capabilities' | 'review-catalog' | 'templates' | 'profile' | 'workflow';
export type CommandHelpName =
    | GuardedCommandHelpName
    | 'stats'
    | 'task'
    | 'html'
    | 'ui'
    | 'off'
    | 'on'
    | 'uninstall'
    | 'status'
    | 'doctor'
    | 'debug'
    | 'cleanup'
    | 'backup'
    | 'repair'
    | 'gc'
    | 'clean';

export interface CommandHelpDescriptor {
    readonly summary: string;
    readonly usage: readonly string[];
    readonly examples: readonly string[];
    readonly hints?: readonly string[];
}

export const COMMAND_HELP: Readonly<Record<CommandHelpName, CommandHelpDescriptor>> = Object.freeze({
    'agent-init': Object.freeze({
        summary: 'Finalize mandatory agent onboarding after AGENT_INIT_PROMPT work is complete.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} agent-init --active-agent-files "<file1>,<file2>" --project-rules-updated true|false --skills-prompted true|false [--ordinary-doc-paths "<path-or-glob,...>"] [--target-root PATH] [--bundle-root PATH] [--init-answers-path PATH]`,
            `${PRIMARY_CLI_NAME} status`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} agent-init --active-agent-files "AGENTS.md,AGENT_INIT_PROMPT.md" --project-rules-updated true --skills-prompted true --ordinary-doc-paths "CHANGELOG.md,docs/plan.md"`
        ]),
        hints: Object.freeze([
            'This command has no subcommands and requires explicit completion flags.',
            'Complete the AGENT_INIT_PROMPT style-policy question before running this command; final answer tokens remain exactly default or custom.',
            'Complete the specialist-skills yes/no question before running this command; --skills-prompted true means the question was shown, even when the user declined extra skills.',
            '--skills-prompted false means the question is still incomplete and keeps readiness blocked.',
            'Confirm --ordinary-doc-paths only after explaining they are auditable planning/status/changelog/product doc routing hints, not a global ignore list or a way to hide files.',
            'Use status first if you need to confirm whether agent-init is still required.'
        ])
    }),
    skills: Object.freeze({
        summary: 'List, suggest, add, remove, and validate optional built-in skill packs.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} skills [list] [--target-root PATH] [--bundle-root PATH]`,
            `${PRIMARY_CLI_NAME} skills suggest --task-text "<task summary>" [--changed-path src/<file>] [--limit N]`,
            `${PRIMARY_CLI_NAME} skills add <pack-id> | remove <pack-id> | validate`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} skills`,
            `${PRIMARY_CLI_NAME} skills suggest --task-text "Improve parity-blocked command discoverability"`
        ]),
        hints: Object.freeze([
            'Default mode: skills with no subcommand behaves like skills list.'
        ])
    }),
    'review-capabilities': Object.freeze({
        summary: 'Show, enable, and disable repo-local optional review capabilities.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} review-capabilities [show|list] [--target-root PATH] [--bundle-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} review-capabilities enable <api|test|performance|infra|dependency> [<capability> ...]`,
            `${PRIMARY_CLI_NAME} review-capabilities disable <api|test|performance|infra|dependency> [<capability> ...]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} review-capabilities`,
            `${PRIMARY_CLI_NAME} review-capabilities list`,
            `${PRIMARY_CLI_NAME} review-capabilities enable api test`
        ]),
        hints: Object.freeze([
            'Default mode: review-capabilities with no subcommand behaves like review-capabilities show.',
            'The list alias behaves like review-capabilities show.'
        ])
    }),
    'review-catalog': Object.freeze({
        summary: 'Inspect and safely manage review lanes, profile policy, and review dependencies.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} review-catalog [list|validate] [--target-root PATH] [--bundle-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} review-catalog <show|explain> <review-id> [--profile NAME] [--json]`,
            `${PRIMARY_CLI_NAME} review-catalog create <review-id> --display-label LABEL --skill-id ID --trigger-mode <manual|signals> --coverage-category ID --role-id ID [--signal-id ID] [--focus-tag TAG]`,
            `${PRIMARY_CLI_NAME} review-catalog update <review-id> [--display-label LABEL] [--skill-id ID] [--trigger-mode <manual|signals>] [--signal-id ID] [--coverage-category ID] [--role-id ID] [--focus-tag TAG]`,
            `${PRIMARY_CLI_NAME} review-catalog <enable|disable> <review-id>`,
            `${PRIMARY_CLI_NAME} review-catalog profile-bind <review-id> --profile NAME --state <disabled|auto|required>`,
            `${PRIMARY_CLI_NAME} review-catalog dependency <review-id> --profile NAME (--depends-on ID | --clear-dependencies)`,
            `${PRIMARY_CLI_NAME} review-catalog migrate [--target-root PATH] [--bundle-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} review-catalog migrate --confirm --expected-state-sha256 SHA256 --expected-plan-sha256 SHA256 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} review-catalog migrate --apply --expected-state-sha256 SHA256 --expected-plan-sha256 SHA256 --confirmation-receipt-sha256 SHA256`,
            `${PRIMARY_CLI_NAME} review-catalog <mutation> <review-id> <same mutation options> --confirm --expected-state-sha256 SHA256 --expected-plan-sha256 SHA256 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} review-catalog <mutation> <review-id> <same mutation options> --apply --expected-state-sha256 SHA256 --expected-plan-sha256 SHA256 --confirmation-receipt-sha256 SHA256`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} review-catalog list --target-root "."`,
            `${PRIMARY_CLI_NAME} review-catalog explain architecture --profile balanced --target-root "."`,
            `${PRIMARY_CLI_NAME} review-catalog migrate --target-root "."`,
            `${PRIMARY_CLI_NAME} review-catalog create architecture --display-label "Architecture review" --skill-id architecture-review --trigger-mode signals --signal-id architecture --coverage-category maintainability --role-id architecture-reviewer --target-root "."`,
            `${PRIMARY_CLI_NAME} review-catalog enable architecture --confirm --expected-state-sha256 "<state-sha256>" --expected-plan-sha256 "<plan-sha256>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --target-root "."`,
            `${PRIMARY_CLI_NAME} review-catalog enable architecture --apply --expected-state-sha256 "<state-sha256>" --expected-plan-sha256 "<plan-sha256>" --confirmation-receipt-sha256 "<receipt-sha256>" --target-root "."`
        ]),
        hints: Object.freeze([
            'A missing catalog remains legacy-compatible: the built-in review lanes and canonical verdict tokens still apply.',
            'Migration is explicit and preview-only by default. It materializes normalized catalog/profile/capability config only after a separate confirmation and apply.',
            'Migration retains legacy capability choices and review execution mode, proves behavioral parity, and is idempotent after normalization.',
            'Custom lanes are disabled by default. Raw prompt bodies and verdict-token overrides are not accepted.',
            'Mutation commands default to preview and affect future task snapshots only. Repeat the same mutation options for each later phase.',
            'The separate --confirm phase requires fresh operator confirmation and the preview state/plan hashes; it returns a one-time confirmation receipt.',
            'The separate --apply phase requires the same preview hashes and confirmation receipt; self-confirmation flags are rejected during apply.'
        ])
    }),
    templates: Object.freeze({
        summary: 'Show, validate, and manage user-owned message template overrides.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} templates [list] [--target-root PATH] [--bundle-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} templates show --template final-report|commit-message|reviewer-prompt [--json]`,
            `${PRIMARY_CLI_NAME} templates path --template final-report|commit-message|reviewer-prompt`,
            `${PRIMARY_CLI_NAME} templates edit --template final-report|commit-message|reviewer-prompt`,
            `${PRIMARY_CLI_NAME} templates validate [--template final-report|commit-message|reviewer-prompt] [--json]`,
            `${PRIMARY_CLI_NAME} templates reset --template final-report|commit-message|reviewer-prompt`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} templates list`,
            `${PRIMARY_CLI_NAME} templates show --template final-report`,
            `${PRIMARY_CLI_NAME} templates edit --template commit-message`,
            `${PRIMARY_CLI_NAME} templates validate`
        ]),
        hints: Object.freeze([
            'Default mode: templates with no subcommand behaves like templates list.',
            'User overrides may change wording, but effective templates preserve protected workflow sections and required placeholders.',
            'The edit action creates or reports the user-owned override path; it does not open an interactive editor.'
        ])
    }),
    profile: Object.freeze({
        summary: 'List, switch, create, delete, validate, and guard workspace profile policies.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} profile [current|list|validate] [--target-root PATH] [--bundle-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} profile use <name>`,
            `${PRIMARY_CLI_NAME} profile create <name> [--description TEXT] [--depth 1|2|3] [--copy-from <existing>]`,
            `${PRIMARY_CLI_NAME} profile delete <name>`,
            `${PRIMARY_CLI_NAME} profile policy preview <name> [--preset soft|balanced|strict|custom | --copy-from <source> | --reset] [--critical fix_now] [--high ACTION] [--medium ACTION] [--low ACTION] [--residual-risk ACTION] [--json]`,
            `${PRIMARY_CLI_NAME} profile policy apply <name> <same policy options as preview> --expected-policy-sha256 <sha256> --expected-plan-sha256 <sha256> --expected-config-sha256 <sha256> --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} profile`,
            `${PRIMARY_CLI_NAME} profile use balanced`,
            `${PRIMARY_CLI_NAME} profile policy preview balanced --preset strict --json`
        ]),
        hints: Object.freeze([
            'Default mode: profile with no subcommand behaves like profile current.',
            'Profile policy apply changes future task snapshots only and requires hashes from a fresh preview plus operator confirmation.'
        ])
    }),
    workflow: Object.freeze({
        summary: 'Show and set repo-local workflow config.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} workflow [show] [--target-root PATH] [--bundle-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} workflow set [--compile-gate-command CMD] [--full-suite on|off|--full-suite-enabled true|false] [--full-suite-command CMD] [--full-suite-timeout-blocker true|false] [--full-suite-timeout-retry-count N] [--full-suite-placement after_compile_before_reviews|before_test_review|before_completion] [--review-execution-policy MODE] [--no-delegate true|false|--review-delegation-no-delegate true|false] [--scope-budget on|off|--scope-budget-enabled true|false] [--scope-budget-action BLOCK_FOR_SPLIT|WARN_ONLY] [--scope-budget-profiles LIST] [--scope-budget-max-files N] [--scope-budget-max-changed-lines N] [--scope-budget-max-required-reviews N] [--scope-budget-max-review-tokens N] [--scope-budget-warn-files N] [--scope-budget-block-files N] [--scope-budget-warn-changed-lines N] [--scope-budget-block-changed-lines N] [--scope-budget-warn-required-reviews N] [--scope-budget-block-required-reviews N] [--scope-budget-warn-review-tokens N] [--scope-budget-block-review-tokens N] [--review-cycle on|off|--review-cycle-enabled true|false] [--review-cycle-action BLOCK_FOR_OPERATOR_DECISION|WARN_ONLY] [--review-cycle-max-failed-non-test-reviews N] [--review-cycle-max-total-non-test-reviews N] [--review-cycle-excluded-review-types LIST] [--review-cycle-auto-split on|off|--review-cycle-auto-split-enabled true|false] [--project-memory on|off|--project-memory-enabled true|false] [--project-memory-mode off|check|update|strict] [--project-memory-run-before-final-closeout on|off] [--project-memory-require-user-approval-for-writes on|off] [--project-memory-max-compact-summary-chars N] [--project-memory-read-strategy index_first] [--project-memory-impact-artifact-retention-days N] [--task-reset on|off|--task-reset-enabled true|false] [--auto-backup on|off|--auto-backup-enabled true|false] [--auto-backup-interval-days N] [--auto-backup-keep-latest N] [--optional-checks on|off|--optional-checks-enabled true|false] [--optional-checks-review-failure-cadence-interval N] [--optional-check-rule-id ID --optional-check-rule-title TITLE --optional-check-rule-prompt PROMPT --optional-check-rule-enabled true|false --optional-check-rule-exclude-test-only true|false] [--optional-check-rule-delete ID] [--optional-skill-selection-mode off|optional|mandatory] [--garda-self-guard on|off] --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" [--target-root PATH] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} workflow`,
            `${PRIMARY_CLI_NAME} workflow set --compile-gate-command "<compile/build/type-check command>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --full-suite on --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --full-suite-enabled true --full-suite-command "npm test" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --full-suite-timeout-blocker true --full-suite-timeout-retry-count 1 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --full-suite-placement before_test_review --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --review-execution-policy strict_sequential --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --no-delegate true|false --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --scope-budget on --scope-budget-warn-changed-lines 2000 --scope-budget-block-changed-lines 5000 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --scope-budget-warn-review-tokens 50000 --scope-budget-block-review-tokens 100000 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --review-cycle-enabled true --review-cycle-max-total-non-test-reviews 30 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --review-cycle-auto-split on --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --project-memory on --project-memory-mode update --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --task-reset on --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --optional-checks on --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --optional-checks-review-failure-cadence-interval 3 --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --optional-check-rule-id custom_focus --optional-check-rule-title "Custom focus" --optional-check-rule-prompt "Check the custom concern." --optional-check-rule-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --optional-check-rule-id custom_focus --optional-check-rule-exclude-test-only true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --optional-skill-selection-mode mandatory --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`,
            `${PRIMARY_CLI_NAME} workflow set --garda-self-guard on`,
            `${PRIMARY_CLI_NAME} workflow set --garda-self-guard off --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`
        ]),
        hints: Object.freeze([
            'Default mode: workflow with no subcommand behaves like workflow show.',
            'compile_gate.command is the executable compile-gate source; unconfigured workspaces fail closed instead of falling back to 40-commands.md.',
            'Compile-gate command changes must stay compile/build/type-check commands and must not match the configured full-suite command.',
            'Full-suite timeout blocker controls whether repeated timeout evidence blocks task progress; timeout retry count controls same-scope retries before blocker handling.',
            'Review execution policy modes: parallel_all, test_after_code, code_first_optional, strict_sequential.',
            'Scope budget guard uses tiered warning and blocking thresholds; legacy --scope-budget-max-* and --scope-budget-action flags remain accepted for old automation.',
            'Legacy --scope-budget-action only controls how max_* values map to warn_* or block_* thresholds; explicit block_* thresholds still block in every mode.',
            'Scope budget guard warnings allow continuation; blocking thresholds move oversized tasks to split-required before compile/review loops.',
            'Review cycle guard can block runaway non-test review attempts; fresh defaults allow 15 failed non-test reviews and 30 total non-test reviews, with test review excluded by default.',
            'Short aliases map exactly to existing boolean settings: --full-suite, --no-delegate, --scope-budget, --review-cycle, --review-cycle-auto-split, --project-memory, --task-reset, --auto-backup, and --optional-checks accept on|off.',
            'Review cycle auto split is disabled by default and can be enabled with --review-cycle-auto-split on.',
            'Project memory maintenance defaults to update mode; use off, check, update, or strict mode for explicit repo-local policy.',
            'Task reset mutations are disabled by default and can be enabled with --task-reset on.',
            'Optional quality checks are advisory, default-enabled, routed before expensive gates when current implementation changes need checklist evidence, and configurable with --optional-checks on|off plus --optional-checks-review-failure-cadence-interval and --optional-check-rule-* without replacing mandatory compile/review/full-suite gates. Use --optional-check-rule-exclude-test-only true to skip one rule only for pure test changes.',
            'Garda self-guard defaults to on for application workspaces and blocks agent self-entry into --orchestrator-work.',
            'workflow set changes require --operator-confirmed yes and --operator-confirmed-at-utc after explicit operator approval, except a standalone --garda-self-guard on change. A true no-op needs no approval unless repairing task-reset audit evidence. Confirmation parsing trims whitespace and ignores letter case; use canonical yes in commands. Agents must not approve workflow-config mutations for themselves.'
        ])
    }),
    stats: Object.freeze({
        summary: 'Show token-overhead and runtime analytics per task or across all tasks.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} stats "<task-id>" [--target-root PATH] [--events-root PATH] [--reviews-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} stats [--task-id "<task-id>"] [--target-root PATH] [--events-root PATH] [--reviews-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} stats --json`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} stats`,
            `${PRIMARY_CLI_NAME} stats "<task-id>"`,
            `${PRIMARY_CLI_NAME} stats --task-id "<task-id>"`,
            `${PRIMARY_CLI_NAME} stats --json`
        ]),
        hints: Object.freeze([
            'Default mode: stats with no task id prints aggregate task analytics.',
            'Use a positional task id or --task-id for task-specific statistics.'
        ])
    }),
    task: Object.freeze({
        summary: 'Inspect one task through read-only stats and event timeline views.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} task "<task-id>" stats [--target-root PATH] [--events-root PATH] [--reviews-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} task "<task-id>" events [--repo-root PATH] [--events-root PATH] [--reviews-root PATH] [--include-details] [--as-json]`,
            `${PRIMARY_CLI_NAME} task help`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} task "<task-id>" stats`,
            `${PRIMARY_CLI_NAME} task "<task-id>" events`,
            `${PRIMARY_CLI_NAME} task "<task-id>" events --include-details`
        ]),
        hints: Object.freeze([
            'This namespace is read-only and does not change task lifecycle state.',
            'Use stats for task metrics and events for the task timeline.',
            'The events action does not expose --output-path; use the gate command directly when you intentionally need an artifact.'
        ])
    }),
    html: Object.freeze({
        summary: 'Write a static read-only HTML report and print its browser link.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} html [--target-root PATH] [--output-path PATH] [--snapshot] [--retain-snapshots N] [--max-detailed-tasks N] [--json]`,
            `${PRIMARY_CLI_NAME} html --output-path "garda-agent-orchestrator/runtime/reports/garda-report.html" --snapshot --retain-snapshots 5`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} html`,
            `${PRIMARY_CLI_NAME} html --target-root "."`,
            `${PRIMARY_CLI_NAME} html --snapshot --retain-snapshots 5`,
            `${PRIMARY_CLI_NAME} html --max-detailed-tasks 0`,
            `${PRIMARY_CLI_NAME} html --json`
        ]),
        hints: Object.freeze([
            'The report is read-only: it reads TASK.md, workflow config, and existing runtime logs/artifacts.',
            'Default output is garda-agent-orchestrator/runtime/reports/garda-report.html.',
            'Use --snapshot to keep a timestamped copy under runtime/reports/snapshots; --retain-snapshots N keeps the newest N snapshots.',
            'Deep per-task runtime details are lazy for static reports and skipped by default so large histories return promptly; use --max-detailed-tasks N for a heavier snapshot.',
            'Open the printed file URL in a browser; no local server is started.'
        ])
    }),
    ui: Object.freeze({
        summary: 'Start a localhost UI with lazy task-detail loading and optional allow-listed actions.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} ui [--target-root PATH] [--port PORT] [--language ${formatLocalUiLanguageCliChoices()}] [--idle-minutes N] [--idle-warning-seconds N] [--no-idle-shutdown] [--read-only] [--actions]`,
            `${PRIMARY_CLI_NAME} ui --target-root "."`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} ui`,
            `${PRIMARY_CLI_NAME} ui --target-root "."`,
            `${PRIMARY_CLI_NAME} ui --port 17340`,
            `${PRIMARY_CLI_NAME} ui --language ru`,
            `${PRIMARY_CLI_NAME} ui --idle-minutes 15 --idle-warning-seconds 60`,
            `${PRIMARY_CLI_NAME} ui --no-idle-shutdown`,
            `${PRIMARY_CLI_NAME} ui --actions`
        ]),
        hints: Object.freeze([
            'The UI server binds only to 127.0.0.1 and prints a browser URL.',
            'The process stays in the foreground; stop it with Ctrl+C or the guarded Server Status stop action.',
            'Idle shutdown is server-owned by default: browser activity pings reset the timer, then a warning countdown appears before the process closes.',
            'The UI chrome supports multiple browser-local languages with English fallback; commands, task IDs, config keys, enum values, paths, and raw output stay untranslated.',
            'After shutdown the page cannot launch a replacement server; rerun garda ui --target-root "." from a terminal.',
            'Task details are loaded on demand through read-only local JSON endpoints.',
            'By default the browser cannot run commands, mutate workflow state, or edit settings.',
            '--actions exposes only allow-listed Garda commands with preview, confirmation for mutating actions, and runtime audit events.'
        ])
    }),
    off: Object.freeze({
        summary: 'Hide Garda root agent instruction files without uninstalling the deployed bundle.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} off [--target-root PATH] [--dry-run]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} off --dry-run`,
            `${PRIMARY_CLI_NAME} off --target-root "."`
        ]),
        hints: Object.freeze([
            'Moves Garda-owned root agent entrypoints into runtime/switch/off and restores user-owned alternatives from runtime/switch/on.',
            'TASK.md remains visible. The deployed bundle remains installed.',
            'Conflicts fail closed without overwriting user files; run --dry-run first when checking a workspace.'
        ])
    }),
    on: Object.freeze({
        summary: 'Restore Garda root agent instruction files after off mode.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} on [--target-root PATH] [--dry-run]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} on --dry-run`,
            `${PRIMARY_CLI_NAME} on --target-root "."`
        ]),
        hints: Object.freeze([
            'Moves user-owned root alternatives into runtime/switch/on and restores Garda-owned files from runtime/switch/off.',
            'Removes the managed .agentignore block created by off mode.',
            'Conflicts fail closed without overwriting user files; run --dry-run first when checking a workspace.'
        ])
    }),
    uninstall: Object.freeze({
        summary: 'Remove the deployed orchestrator while preserving TASK.md by default.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} uninstall [--target-root PATH] [--no-prompt] [--dry-run] [--skip-backups] [--keep-primary-entrypoint yes|no] [--keep-task-file yes|no] [--keep-runtime-artifacts yes|no] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} uninstall --target-root "."`,
            `${PRIMARY_CLI_NAME} uninstall --target-root "." --no-prompt`,
            `${PRIMARY_CLI_NAME} uninstall --target-root "." --no-prompt --keep-task-file no`
        ]),
        hints: Object.freeze([
            'TASK.md is preserved by default, including in --no-prompt mode.',
            '--keep-task-file no is the explicit destructive override that removes the managed queue.',
            'Without --skip-backups, explicit TASK.md removal reports TaskFileRecoveryPath for the exact pre-removal copy.',
            'Combining --keep-task-file no with --skip-backups intentionally removes the managed queue without a recovery copy.'
        ])
    }),
    status: Object.freeze({
        summary: 'Show current project status without changing files.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} status [--target-root PATH] [--bundle-root PATH] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} status`,
            `${PRIMARY_CLI_NAME} status --json`
        ]),
        hints: Object.freeze([
            'Status is read-only and is safe to run before task work.'
        ])
    }),
    doctor: Object.freeze({
        summary: 'Run verify plus manifest validation using existing init answers.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} doctor [--target-root PATH] [--bundle-root PATH] [--json] [--cleanup-stale-locks] [--dry-run]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} doctor`,
            `${PRIMARY_CLI_NAME} doctor --cleanup-stale-locks --dry-run`
        ]),
        hints: Object.freeze([
            'Doctor is for diagnostics and validation; use --dry-run when checking cleanup behavior.'
        ])
    }),
    debug: Object.freeze({
        summary: 'Show environment and runtime triage snapshots for bug reports.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} debug env [--target-root PATH] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} debug env`,
            `${PRIMARY_CLI_NAME} debug env --json`
        ]),
        hints: Object.freeze([
            'Default help lists the debug namespace. The currently supported debug subcommand is env.'
        ])
    }),
    cleanup: Object.freeze({
        summary: 'Remove stale runtime artifacts and inspect tiered retention policy.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} cleanup [--target-root PATH] [--dry-run] [--confirm] [--max-age-days N] [--runtime-retention-older-than-days N] [--runtime-retention-keep-latest-tasks N] [--max-backups N] [--max-working-plans N] [--max-aggregate-lines N] [--max-metrics-lines N]`,
            `${PRIMARY_CLI_NAME} cleanup policy [show|edit] [--target-root PATH]`,
            `${PRIMARY_CLI_NAME} cleanup batch-task-purge [--target-root PATH] [--runtime-retention-older-than-days N] [--runtime-retention-keep-latest-tasks N] [--include-problematic-tasks] [--dry-run|--confirm] [--json]`,
            `${PRIMARY_CLI_NAME} cleanup task-purge --task-id "<task-id>" [--target-root PATH] [--dry-run|--confirm] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} cleanup --dry-run`,
            `${PRIMARY_CLI_NAME} cleanup policy`,
            `${PRIMARY_CLI_NAME} cleanup policy edit`,
            `${PRIMARY_CLI_NAME} cleanup batch-task-purge --runtime-retention-older-than-days 30 --runtime-retention-keep-latest-tasks 20 --dry-run`,
            `${PRIMARY_CLI_NAME} cleanup task-purge --task-id "<task-id>" --dry-run`
        ]),
        hints: Object.freeze([
            'Use dry-run first when removing runtime artifacts.',
            'Manual runtime cleanup batch purge selects non-active task-owned artifacts older than N days or outside the latest N by filesystem recency, and --include-problematic-tasks also includes stale problematic runtime-active histories while still protecting current active work.',
            'Runtime retention tiers are active evidence, ledger history for healthy DONE tasks, compressed forensic evidence for problem tasks, and confirmed purge.',
            'Clean-success compile/full-suite raw logs may be omitted at gate time; warnings, failures, and non-clean runs retain raw output.',
            'Working-plan cleanup is limited to runtime/plans/*.md and preserves active task plans.',
            'Task purge removes only runtime artifacts owned by the selected task id and repairs shared aggregates instead of deleting shared files wholesale.',
            'The policy subcommand is the human-facing review-artifact storage policy editor/viewer.'
        ])
    }),
    backup: Object.freeze({
        summary: 'Create manual rollback backup snapshots.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} backup create --confirm [--target-root PATH] [--init-answers-path PATH] [--json]`,
            `${PRIMARY_CLI_NAME} backup create --dry-run [--target-root PATH] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} backup create --dry-run`,
            `${PRIMARY_CLI_NAME} backup create --confirm`
        ]),
        hints: Object.freeze([
            'backup create writes a manual snapshot under runtime/update-rollbacks and includes rollback records for restore.',
            'Mutating backup create requires --confirm; use the live UI with --actions for guarded browser confirmation.'
        ])
    }),
    repair: Object.freeze({
        summary: 'Inspect and repair runtime indexes, task timelines, protected manifests, and stale lock state.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} repair [inspect] [--target-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} repair rebuild-indexes [--target-root PATH] [--confirm] [--json]`,
            `${PRIMARY_CLI_NAME} repair protected-manifest [--target-root PATH] [--confirm] [--json]`,
            `${PRIMARY_CLI_NAME} repair locks [--target-root PATH] [--cleanup-stale] [--confirm] [--json]`,
            `${PRIMARY_CLI_NAME} repair catalog health [--target-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} repair catalog drift [--target-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} repair catalog repair [--target-root PATH] [--confirm] [--json]`,
            `${PRIMARY_CLI_NAME} repair catalog rebuild [--target-root PATH] [--confirm] [--json]`,
            `${PRIMARY_CLI_NAME} repair task-events migrate-legacy-suffix --task-id ID [--target-root PATH] [--json]`,
            `${PRIMARY_CLI_NAME} repair task-events migrate-legacy-suffix --task-id ID --apply --expected-plan-sha256 HASH [--target-root PATH] [--json]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} repair inspect`,
            `${PRIMARY_CLI_NAME} repair rebuild-indexes`,
            `${PRIMARY_CLI_NAME} repair rebuild-indexes --confirm`,
            `${PRIMARY_CLI_NAME} repair locks --cleanup-stale`,
            `${PRIMARY_CLI_NAME} repair protected-manifest --confirm`,
            `${PRIMARY_CLI_NAME} repair catalog health`,
            `${PRIMARY_CLI_NAME} repair catalog drift`,
            `${PRIMARY_CLI_NAME} repair catalog repair --confirm`,
            `${PRIMARY_CLI_NAME} repair catalog rebuild --confirm`,
            `${PRIMARY_CLI_NAME} repair task-events migrate-legacy-suffix --task-id T-123 --json`,
            `${PRIMARY_CLI_NAME} repair task-events migrate-legacy-suffix --task-id T-123 --apply --expected-plan-sha256 HASH --json`
        ]),
        hints: Object.freeze([
            'inspect is read-only and names canonical versus derived runtime state.',
            'rebuild-indexes and protected-manifest are dry-run by default; pass --confirm to write.',
            'locks reports task-event, review-artifact, and completion-finalization locks; cleanup only removes proven-stale task-event/review-artifact locks after --cleanup-stale --confirm.',
            'catalog health and drift are read-only; catalog repair and rebuild are preview-first and require --confirm to write.',
            'task-events migrate-legacy-suffix is read-only by default; apply requires the exact plan hash from a current eligible preview.'
        ])
    }),
    gc: Object.freeze({
        summary: 'Extended cleanup with dry-run default, retention tiers, stale locks, and generated-zone cleanup.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} gc [--target-root PATH] [--category NAME] [--max-age-days N] [--runtime-retention-older-than-days N] [--runtime-retention-keep-latest-tasks N] [--max-working-plans N] [--max-aggregate-lines N] [--max-metrics-lines N] [--confirm]`,
            `${PRIMARY_CLI_NAME} clean [--target-root PATH] [--category NAME] [--runtime-retention-older-than-days N] [--runtime-retention-keep-latest-tasks N] [--confirm]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} gc`,
            `${PRIMARY_CLI_NAME} gc --category reviews`,
            `${PRIMARY_CLI_NAME} gc --category stale-locks`,
            `${PRIMARY_CLI_NAME} gc --confirm`
        ]),
        hints: Object.freeze([
            'gc is dry-run by default; pass --confirm to apply retention-approved removal or compression.',
            'Manual runtime retention can be limited with --runtime-retention-older-than-days N and --runtime-retention-keep-latest-tasks N.',
            'Healthy DONE task compaction requires verified ledger evidence; problem tasks keep recovery-readable evidence and compress only heavy forensic artifacts.',
            'Full purge is never automatic; use explicit confirmed cleanup after reviewing the dry-run output.',
            'Use --category plans to limit cleanup to retained runtime working-plan files.'
        ])
    }),
    clean: Object.freeze({
        summary: 'Alias for gc extended cleanup.',
        usage: Object.freeze([
            `${PRIMARY_CLI_NAME} clean [--target-root PATH] [--category NAME] [--max-age-days N] [--runtime-retention-older-than-days N] [--runtime-retention-keep-latest-tasks N] [--max-working-plans N] [--max-aggregate-lines N] [--max-metrics-lines N] [--confirm]`
        ]),
        examples: Object.freeze([
            `${PRIMARY_CLI_NAME} clean`,
            `${PRIMARY_CLI_NAME} clean --confirm`
        ]),
        hints: Object.freeze([
            'clean is an alias for gc and is dry-run by default unless --confirm is passed.',
            'Manual runtime retention can be limited with --runtime-retention-older-than-days N and --runtime-retention-keep-latest-tasks N.'
        ])
    })
});

function styleHelpToken(token: string): string {
    const trimmed = token.trim();
    const normalized = trimmed.replace(/^[[(]+|[\]),]+$/g, '');
    if (!trimmed) {
        return trimmed;
    }
    if (trimmed.startsWith('--') || trimmed.startsWith('[--')) {
        return yellow(trimmed);
    }
    if (
        normalized === PRIMARY_CLI_NAME
        || normalized === PRIMARY_PACKAGE_NAME
        || normalized === 'node'
        || normalized.endsWith('garda.js')
        || [
            'setup', 'agent-init', 'status', 'doctor', 'debug', 'stats', 'task', 'html', 'ui', 'off', 'on', 'bootstrap', 'install', 'init', 'reinit',
            'update', 'rollback', 'backup', 'uninstall', 'cleanup', 'repair', 'gc', 'clean', 'verify', 'check-update', 'skills',
            'review-capabilities', 'review-catalog', 'templates', 'profile', 'workflow', 'diff-managed', 'gate', 'show', 'set', 'list', 'current',
            'use', 'create', 'delete', 'validate', 'suggest', 'add', 'remove', 'enable', 'disable', 'edit', 'reset',
            'inspect', 'rebuild-indexes', 'protected-manifest', 'locks', 'catalog', 'health', 'drift', 'rebuild',
            'events'
        ].includes(normalized)
    ) {
        return cyan(trimmed);
    }
    if (
        normalized.startsWith('<')
        || normalized.startsWith('[')
        || normalized.includes('|')
        || normalized === 'PATH'
        || normalized === 'TEXT'
        || normalized === 'CMD'
        || normalized === 'N'
    ) {
        return dim(trimmed);
    }
    return trimmed;
}

export function styleHelpCommandLine(line: string): string {
    return line
        .split(/\s+/)
        .map((token) => styleHelpToken(token))
        .join(' ');
}

export function isKnownCommandHelpName(commandName: string): commandName is CommandHelpName {
    return Object.prototype.hasOwnProperty.call(COMMAND_HELP, commandName);
}

export function buildCommandHelpText(commandName: CommandHelpName): string {
    const entry = COMMAND_HELP[commandName];
    const lines: string[] = [];
    lines.push('GARDA_COMMAND_HELP');
    lines.push(cyan(commandName));
    lines.push(dim(entry.summary));
    lines.push('');
    lines.push(bold('Usage'));
    for (const usageLine of entry.usage) {
        lines.push(`  ${styleHelpCommandLine(usageLine)}`);
    }
    if (entry.hints && entry.hints.length > 0) {
        lines.push('');
        lines.push(bold('Hints'));
        for (const hint of entry.hints) {
            lines.push(`  ${dim(hint)}`);
        }
    }
    lines.push('');
    lines.push(bold('Examples'));
    for (const exampleLine of entry.examples) {
        lines.push(`  ${green(exampleLine)}`);
    }
    return lines.join('\n');
}

export function buildGuardedCommandHelpText(commandName: GuardedCommandHelpName): string {
    return buildCommandHelpText(commandName);
}

export function buildParityBlockedCommandText(options: {
    commandName: string;
    helpText: string;
    violations: readonly string[];
    remediation: string | null | undefined;
    parityRoot?: string;
    policyMode?: string;
    policyReason?: string;
}): string {
    const lines: string[] = [];
    lines.push(red('PARITY_BLOCKED'));
    lines.push(red(`BlockedCommand: ${options.commandName}`));
    if (options.policyMode) {
        lines.push(red(`ParityPolicy: ${options.policyMode}`));
    }
    if (options.parityRoot) {
        lines.push(red(`ParityRoot: ${options.parityRoot}`));
    }
    if (options.policyReason) {
        lines.push(red(`PolicyReason: ${options.policyReason}`));
    }
    lines.push(red('Source Parity Violation: The deployed bundle is stale compared to the source checkout.'));
    if (options.violations.length > 0) {
        lines.push('');
        lines.push(bold('Detected drift'));
        for (const violation of options.violations) {
            lines.push(`  ${red(violation)}`);
        }
    }
    if (options.remediation) {
        lines.push('');
        lines.push(bold('Fix'));
        lines.push(`  ${green(options.remediation)}`);
    }
    lines.push('');
    lines.push(options.helpText);
    return lines.join('\n');
}

export function buildParityWarningCommandText(options: {
    commandName: string;
    violations: readonly string[];
    remediation: string | null | undefined;
    parityRoot: string;
    policyMode: string;
    policyReason: string;
}): string {
    const lines: string[] = [];
    lines.push(yellow('PARITY_WARNING'));
    lines.push(yellow(`AllowedCommand: ${options.commandName}`));
    lines.push(yellow(`ParityPolicy: ${options.policyMode}`));
    lines.push(yellow(`ParityRoot: ${options.parityRoot}`));
    lines.push(yellow(`PolicyReason: ${options.policyReason}`));
    lines.push(yellow('Source Parity Warning: The deployed bundle is stale compared to the source checkout, but this command is allowed by policy.'));
    if (options.violations.length > 0) {
        lines.push('');
        lines.push(bold('Detected drift'));
        for (const violation of options.violations) {
            lines.push(`  ${yellow(violation)}`);
        }
    }
    if (options.remediation) {
        lines.push('');
        lines.push(bold('Fix'));
        lines.push(`  ${green(options.remediation)}`);
    }
    return lines.join('\n');
}

export function printHelp(packageJson: PackageJsonLike): void {
    console.log(buildHelpText(packageJson));
}

export function buildHelpText(packageJson: PackageJsonLike): string {
    const defaultRetentionPolicy = buildDefaultRetentionPolicy();
    const retentionDefaultsSummary = RETENTION_POLICY_DEFAULTS
        .map((item) => `${defaultRetentionPolicy[item.policyKey]} ${item.label}`)
        .join(', ');
    const retentionOverrideFlags = [
        '--runtime-retention-older-than-days',
        '--runtime-retention-keep-latest-tasks',
        ...RETENTION_POLICY_DEFAULTS.map((item) => item.flag)
    ].join(', ');
    const sections = [
        [
            `${PRODUCT_NAME} CLI v${packageJson.version}`,
            'Usage:',
            `  ${PRIMARY_PACKAGE_NAME}`,
            `  ${PRIMARY_PACKAGE_NAME} setup [options]`,
            `  ${PRIMARY_PACKAGE_NAME} status [options]`,
            `  ${PRIMARY_PACKAGE_NAME} COMMAND [options]`
        ],
        [
            'Commands:',
            '  setup         First-run onboarding: deploy/refresh bundle, collect init answers, run install, and validate manifest.',
            '  agent-init    Finalize mandatory agent onboarding after AGENT_INIT_PROMPT work is complete.',
            '  preprompt     Read-only task bootstrap context and exact next commands.',
            '  next-step     Show the deterministic next command for a task.',
            '  status        Show current project status without changing files.',
            '  doctor        Run verify + manifest validation using existing init answers.',
            '  debug env     Show environment and runtime triage snapshot for bug reports.',
            '  stats         Show token-overhead and runtime analytics per task or across all tasks.',
            '  task          Inspect one task via read-only stats and event timeline views.',
            '  html          Write a static read-only HTML report and print its browser link.',
            '  ui            Start a read-only localhost UI with lazy task details.',
            '  off           Hide Garda root agent instruction files without uninstalling.',
            '  on            Restore Garda root agent instruction files after off mode.',
            '  bootstrap     Deploy the bundle only.',
            '  install       Deploy or refresh the bundle and run the Node install pipeline.',
            '  init          Re-materialize live/ from an existing deployed bundle.',
            '  reinit        Re-ask or override init answers for an existing deployed bundle.',
            '  update        Check for updates and optionally apply them (npm by default).',
            '  update git    Apply update from a git repo or local git clone.',
            '  rollback      Rollback to a specific version or restore from the latest rollback snapshot.',
            '  backup        Create a manual rollback backup snapshot.',
            '  uninstall     Remove the deployed orchestrator bundle and managed files; preserve TASK.md by default (--keep-task-file no removes it).',
            '  cleanup       Remove stale runtime artifacts and manage review-artifact storage policy.',
            '  repair        Inspect and rebuild runtime indexes, protected manifests, and stale lock state.',
            '  gc            Extended cleanup with dry-run default, allowlist, stale locks, and isolation sandbox (alias: clean).',
            '  verify        Validate deployment consistency and rule contracts.',
            '  check-update  Compare current deployment with a newer npm package or local source.',
            '  skills        List, suggest, add, remove, and validate optional built-in skill packs.',
            '  review-capabilities  Show, enable, and disable repo-local optional review capabilities.',
            '  review-catalog  Inspect and safely manage review lanes, profiles, and dependencies.',
            '  templates     Show, validate, and manage user-owned message template overrides.',
            '  workflow      Show and set repo-local workflow config.',
            '  profile       List, use, create, delete, validate, and manage finding policy for workspace profiles.',
            '  diff-managed  Show managed vs user-owned block ownership across workspace files.',
            '  gate          Run an agent gate or helper command.'
        ],
        [
            'Global options:',
            '  -h, --help                 Show this help message.',
            '  -v, --version              Show the package version.',
            '      --no-color             Disable colored output (honors NO_COLOR env var).',
            '      --offline              Block network-sensitive commands (env: GARDA_OFFLINE=1).',
            '      --force-network        Override --offline for a single invocation.'
        ],
        [
            'Shared lifecycle options:',
            '      --target-root PATH           Workspace root. Defaults to the current working directory.',
            '      --init-answers-path PATH     Path inside the workspace to agent-produced init answers.'
        ],
        [
            'Bootstrap/install source override options:',
            '      --repo-url URL               Clone bundle source from a repo instead of the packaged bundle.',
            '      --branch NAME                Clone a specific branch for branch testing.'
        ],
        [
            'Update source override options:',
            '      --package-spec SPEC          npm package spec, version tag, or local .tgz for check-update/update.',
            '      --source-path PATH           Local unpacked bundle root for check-update/update testing.',
            '      --check-only                 Compare a git source without applying the update.',
            '      --to-version VERSION         Update or rollback to a specific version.',
            '      --repo-url URL               Compare against or update from a git repo.',
            '      --branch NAME                Compare against or update from a git branch.',
            `      --snapshot-path PATH         Explicit rollback snapshot path for \`${PRIMARY_CLI_NAME} rollback\`.`
        ],
        [
            'Notes:',
            '  - setup/install/bootstrap act on the current working directory unless --target-root is provided.',
            '  - update compares installed vs available bundle versions and prints a summary before applying changes.',
            '  - rollback without --to-version restores the latest saved pre-update snapshot; with --to-version it acquires that version, syncs the bundle, and re-materializes the workspace.',
            '  - older snapshots created before rollback metadata persistence cannot be restored automatically.',
            `  - cleanup uses retention defaults (${retentionDefaultsSummary}); override with ${retentionOverrideFlags}.`,
            '  - runtime retention is tiered: active evidence is preserved, healthy DONE tasks can compact to ledger history after verified ledger evidence, problem tasks keep recovery-readable evidence and compress heavy forensic artifacts, and purge requires explicit confirmation.',
            '  - clean-success compile/full-suite raw logs may be intentionally omitted at gate time; retained summaries still record status, duration, hashes, and line/char counts.',
            `  - use \`${PRIMARY_CLI_NAME} cleanup policy edit\` for the dialog-first review-artifact storage policy editor, or \`${PRIMARY_CLI_NAME} cleanup policy\` to inspect current settings.`,
            '  - gc/clean is dry-run by default; pass --confirm to apply retention-approved removal or compression. Supports --category, --runtime-retention-older-than-days, --runtime-retention-keep-latest-tasks, --max-working-plans, --max-aggregate-lines, and --max-metrics-lines.',
            `  - running \`${PRIMARY_CLI_NAME} profile create\` with no profile name in a TTY starts the full interactive profile builder.`,
            `  - use \`${PRIMARY_CLI_NAME} help <command>\` or \`${PRIMARY_CLI_NAME} <command> help\` for command-specific usage.`,
            `  - use \`${PRIMARY_CLI_NAME} gate help <gate-name>\` or \`${PRIMARY_CLI_NAME} gate <gate-name> --help\` for gate-specific usage.`,
            `  - ${PRODUCT_ACRONYM} = ${PRODUCT_ACRONYM_EXPANSION}. Available command names: ${ALL_CLI_NAMES.join(', ')}.`
        ]
    ];

    return sections.map((section) => section.join('\n')).join('\n\n');
}
