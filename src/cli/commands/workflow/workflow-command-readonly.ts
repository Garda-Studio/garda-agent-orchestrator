import { WORKFLOW_SET_CONFIRMATION_EXAMPLE } from '../../../core/workflow-command-guidance';
import {
    readWorkflowConfigState,
    resolveWorkflowRoots
} from './workflow-command-state';
import {
    buildWorkflowShowResult,
    colorizeWorkflowHumanOutput,
    formatWorkflowShowOutput
} from './workflow-command-rendering';
import type {
    ParsedOptionsRecord,
    WorkflowExplainResult,
    WorkflowShowResult,
    WorkflowValidateResult
} from './workflow-command-types';

export function handleShow(options: ParsedOptionsRecord): WorkflowShowResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath, roots.bundleRoot);
    const result = buildWorkflowShowResult(roots, state);
    console.log(formatWorkflowShowOutput(result, options.json === true));
    return result;
}

export function handleValidate(options: ParsedOptionsRecord): WorkflowValidateResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath, roots.bundleRoot);
    const result: WorkflowValidateResult = {
        ...buildWorkflowShowResult(roots, state),
        action: 'validate',
        status: 'PASS'
    };
    if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(colorizeWorkflowHumanOutput([
            'GARDA_WORKFLOW',
            'Action: validate',
            'Status: PASS',
            `ConfigPath: ${roots.configPath}`,
            result.compile_gate_summary_line,
            result.scope_budget_guard_summary_line,
            result.review_cycle_guard_summary_line,
            result.project_memory_maintenance_summary_line,
            result.task_reset_summary_line,
            result.optional_quality_checks_summary_line
        ].join('\n')));
    }
    return result;
}

export function handleExplain(options: ParsedOptionsRecord): WorkflowExplainResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath, roots.bundleRoot);
    const result: WorkflowExplainResult = {
        ...buildWorkflowShowResult(roots, state),
        action: 'explain',
        topic: 'workflow-guards',
        explanation: [
            'Compile gate command: workflow-config compile_gate.command is the executable compile-gate source; missing values or __COMPILE_GATE_COMMAND_UNCONFIGURED__ fail closed instead of falling back to 40-commands.md.',
            `Set compile_gate.command with workflow set --compile-gate-command "<compile/build/type-check command>" ${WORKFLOW_SET_CONFIRMATION_EXAMPLE} after operator approval; 40-commands.md is human guidance only.`,
            'Compile gate command changes are validated as compile/build/type-check commands and must not match the configured full-suite validation command.',
            'Scope budget guard: warns on large configured-profile tasks and blocks oversized tasks before compile/review loops.',
            'Scope budget guard compares changed file count, changed line count, distinct required review type count, and estimated review tokens against tiered warning and blocking workflow-config.json limits.',
            'Required review types means the review categories required by the current preflight; disabled review capabilities do not become required just because matching files changed, and this is not the number of reviewers, completed review attempts, or review cycles.',
            'Estimated review tokens are a heuristic forecast from review type base cost plus changed file and changed line costs; they are not measured model tokenizer output.',
            'Legacy scope_budget_guard.action is still accepted for old configs: WARN_ONLY maps legacy max_* values to warning thresholds, and BLOCK_FOR_SPLIT maps legacy max_* values to blocking thresholds.',
            'Legacy scope_budget_guard.action does not disable tiered blocking: explicit block_* thresholds produce BLOCK in every action mode.',
            'When a warning threshold is exceeded, next-step continues to the next gate and prints the scope-budget violation under Warnings.',
            'When a blocking threshold is exceeded, next-step blocks ordinary continuation and asks the operator to split or decompose the task.',
            'Review cycle guard: stops runaway non-test review cycles after the configured failed or total review-attempt thresholds are exceeded.',
            'The fresh default review-cycle limits are 15 failed non-test reviews and 30 total non-test reviews; the guard triggers only when a count is greater than its configured limit.',
            'Review cycle attempts are deduplicated only when review type, reviewer identity, and review context hash all match; otherwise each timeline event is counted separately.',
            'Review cycle guard excluded_review_types are not counted; the default excludes test reviews because reaching test review means code-facing review lanes have already been handled.',
            'When review_cycle_guard.action is BLOCK_FOR_OPERATOR_DECISION, next-step blocks compile, review, and full-suite continuation until the operator chooses a recovery path; allow_one_more_cycle is a task-scoped runtime approval, while raise_limits is a permanent repo-local workflow-config change through workflow set.',
            'When review_cycle_guard.auto_split_enabled is false, next-step tells the agent to wait for operator direction after a blocking review-cycle violation.',
            'When review_cycle_guard.auto_split_enabled is true, next-step emits a dedicated auto-split prompt artifact for the agent instead of waiting for operator input.',
            'When review_cycle_guard.action is WARN_ONLY, next-step continues to the next gate but prints the review-cycle violation under Warnings.',
            `Task reset: confirmed reset mutations are disabled by default and require audited opt-in with workflow set --task-reset on ${WORKFLOW_SET_CONFIRMATION_EXAMPLE}.`,
            'Optional quality checks: advisory self-check rules are default-enabled, run before expensive gates when routed by next-step, are configurable through guarded workflow settings, and do not replace compile, review, or full-suite validation.',
            'workflow set changes require explicit operator approval with --operator-confirmed yes and --operator-confirmed-at-utc, except a standalone --garda-self-guard on change. A true no-op needs no approval unless repairing task-reset audit evidence; agents must not approve workflow-config mutations for themselves.',
            'Task reset dry-run remains available while disabled because it only reports reset scope and does not mutate task status or artifacts.'
        ]
    };
    if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log('GARDA_WORKFLOW');
        console.log('Action: explain');
        console.log('Topic: workflow-guards');
        console.log(result.compile_gate_summary_line);
        console.log(result.scope_budget_guard_summary_line);
        console.log(result.review_cycle_guard_summary_line);
        console.log(result.task_reset_summary_line);
        console.log(result.optional_quality_checks_summary_line);
        for (const line of result.explanation) {
            console.log(`- ${line}`);
        }
    }
    return result;
}
