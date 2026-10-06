import { getBundleCliCommand, resolveBundleName } from '../core/constants';
import {
    FRESH_MAIN_AGENT_START_BANNER_RULE,
    START_BANNER_EXEMPTION_RULE,
    START_BANNER_GATE_LIST_RULE
} from '../core/orchestrator-start-banner';

export interface RuleContractSectionMigration {
    liveRelativePath: string;
    templateRelativePath: string;
    heading: string;
    requiredSnippets: readonly string[];
}

let _cachedMigrations: readonly RuleContractSectionMigration[] | null = null;

export function getTaskModeRuleSectionMigrations(): readonly RuleContractSectionMigration[] {
    if (_cachedMigrations) return _cachedMigrations;
    const bn = resolveBundleName();
    _cachedMigrations = Object.freeze([
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/40-commands.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/40-commands.md`,
        heading: '### Manual Validation Evidence Selector',
        requiredSnippets: Object.freeze([
            'root `task_id` matching the current task',
            '"task_id": "T-042"',
            '"selected_logs"',
            'they never replace mandatory gates or review receipts'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/40-commands.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/40-commands.md`,
        heading: '### Compile Gate (Mandatory)',
        requiredSnippets: Object.freeze([
            '### Compile Gate (Mandatory)',
            'must be a compile/build/type-check command',
            'Do not use full-suite test commands here',
            `${getBundleCliCommand(bn)} gate compile-gate`
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/40-commands.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/40-commands.md`,
        heading: '## Agent Gates',
        requiredSnippets: Object.freeze([
            `${getBundleCliCommand(bn)} gate enter-task-mode`,
            `${getBundleCliCommand(bn)} gate load-rule-pack`,
            `${getBundleCliCommand(bn)} gate bind-rule-pack-to-preflight`,
            '`classify-change` fails without rule-pack evidence',
            'Compile gate additionally validates post-preflight rule-pack evidence',
            '`required-reviews-check` additionally validates post-preflight rule-pack evidence',
            'Compile gate additionally validates explicit task-mode entry evidence from `enter-task-mode`.',
            '`required-reviews-check` additionally validates explicit task-mode entry evidence (`TASK_MODE_ENTERED`) before review pass can succeed.',
            'pass the same `--task-mode-path` through `classify-change`, `load-rule-pack`, `bind-rule-pack-to-preflight`',
            '`build-review-context` before every required reviewer invocation, even when token economy is inactive',
            '`build-review-context` writes `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, and `SKILL_REFERENCE_LOADED` automatically for the selected review skill.',
            'ordered lifecycle evidence (`PREFLIGHT_CLASSIFIED`, `IMPLEMENTATION_STARTED`, `REVIEW_PHASE_STARTED`), real review-skill telemetry (`SKILL_SELECTED`, `SKILL_REFERENCE_LOADED`)',
            'Task timeline completeness is surfaced by `status` and `doctor`, not just completion-gate.'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/40-commands.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/40-commands.md`,
        heading: '### Optional Command Reference Appendix',
        requiredSnippets: Object.freeze([
            '### Optional Command Reference Appendix',
            '40-command-reference.md',
            'Do not add the appendix to mandatory `TASK_ENTRY` or `POST_PREFLIGHT`'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/80-task-workflow.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/80-task-workflow.md`,
        heading: '## Agent Start Contract',
        requiredSnippets: Object.freeze([
            'The canonical user instruction is: Execute task <task-id> from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.',
            'Active profile selection comes from `live/config/profiles.json` and the `TASK.md` `Profile` column; do not present `depth=<1|2|3>` as normal user task-start guidance.',
            FRESH_MAIN_AGENT_START_BANNER_RULE,
            START_BANNER_GATE_LIST_RULE,
            START_BANNER_EXEMPTION_RULE,
            'If the workspace already contains modified files before task-mode entry and the run is not isolated through staged or explicit scope, stop and treat the start as invalid.'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/80-task-workflow.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/80-task-workflow.md`,
        heading: '## Review Catalog Context Contract',
        requiredSnippets: Object.freeze([
            'Built-in review lanes and their canonical verdict tokens remain compatibility-owned',
            'Custom review lanes are declarative and disabled by default',
            'immutable current-task catalog/policy snapshot',
            'Do not load `live/config/review-catalog.json` into normal task or reviewer context',
            '`review-catalog list|show|explain|validate`'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/80-task-workflow.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/80-task-workflow.md`,
        heading: '## Mandatory Gate Contract',
        requiredSnippets: Object.freeze([
            'Task-mode entry command must pass before preflight or implementation:',
            'TASK_MODE_ENTERED',
            'Baseline downstream rules must be opened and recorded before preflight:',
            'RULE_PACK_LOADED',
            'HANDSHAKE_DIAGNOSTICS_RECORDED',
            'SHELL_SMOKE_PREFLIGHT_RECORDED',
            'PREFLIGHT_STARTED',
            'IMPLEMENTATION_STARTED',
            'REVIEW_PHASE_STARTED',
            'SKILL_SELECTED',
            'SKILL_REFERENCE_LOADED',
            'After preflight decides `required_reviews.*`, re-run `load-rule-pack --stage "POST_PREFLIGHT" --preflight-path ...`',
            'After preflight decides `required_reviews.*`, run the exact POST_PREFLIGHT command printed by `next-step`',
            'Downstream review preparation must follow the current-cycle dependency graph from `preflight.review_execution_policy`; do not start `test` until every required upstream dependency for the active policy has an accepted findings receipt with findings-satisfied state.',
            'If a later cycle changes only test scope, still run `build-review-context` for reusable upstream `code` review first so current-cycle reuse evidence exists before `test` review starts.',
            'Compile gate validates post-preflight rule-pack evidence',
            'Review gate command validates task-mode entry evidence (`TASK_MODE_ENTERED`) for the same task id.',
            'Review gate command validates post-preflight rule-pack evidence (`RULE_PACK_LOADED`)',
            'gate task-audit-summary --task-id "<task-id>" --as-json',
            'Final user report order is mandatory: short agent-authored summary of what changed -> verbatim Garda final user report',
            'The Garda final user report artifact is generated by `task-audit-summary`; do not reinterpret, summarize, reorder, or rewrite it.',
            'paste `CopyPasteFinalUserReport` exactly as printed, without code fences, wrappers, paraphrase, interpretation, summarization, or reformatting',
            'final delivery must not add commit readiness or extra review-integrity prose outside the generated artifact.',
            'Commit command suggestions and commit permission questions are allowed only after the verbatim generated report and only when `next-step` lists them in `FinalReportOrder`.',
            'ordered lifecycle evidence (`TASK_MODE_ENTERED`, `RULE_PACK_LOADED`, `PREFLIGHT_CLASSIFIED`, `IMPLEMENTATION_STARTED`, `COMPILE_GATE_PASSED`, `REVIEW_PHASE_STARTED`, review pass evidence), review-skill telemetry (`SKILL_SELECTED`, `SKILL_REFERENCE_LOADED`)',
            'Task timeline completeness is surfaced in `status` and `doctor`',
            'HARD STOP: do not skip `load-rule-pack`',
            'HARD STOP: do not skip `enter-task-mode`',
            'HARD STOP: do not launch required reviewers without `build-review-context`; completion requires review-skill telemetry.'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/80-task-workflow.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/80-task-workflow.md`,
        heading: '## Integrity Priority Rules',
        requiredSnippets: Object.freeze([
            '## Integrity Priority Rules',
            'Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
            'Mandatory gate failure means stop or `BLOCKED`; never workaround the gate, script around it, or claim progress that depends on missing evidence.',
            'Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
            'Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.',
            'If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/90-skill-catalog.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/90-skill-catalog.md`,
        heading: '## Preflight Gate (Mandatory)',
        requiredSnippets: Object.freeze([
            'Before preflight, enter task mode explicitly:',
            `${getBundleCliCommand(bn)} gate enter-task-mode`,
            'record the baseline downstream rules that were actually opened',
            `${getBundleCliCommand(bn)} gate load-rule-pack`,
            'After preflight, re-run `load-rule-pack --stage "POST_PREFLIGHT"`',
            'After preflight, run the exact POST_PREFLIGHT rule-pack command printed by `next-step`',
            'Use `bind-rule-pack-to-preflight` only when `next-step` prints it',
            'build-review-context --review-type "<review-type>" --depth "<1|2|3>"',
            'Review launch dependencies come from `preflight.review_execution_policy`; prepare `test` only after every required upstream dependency for the active policy has an accepted findings receipt with findings-satisfied state.',
            'On pure test-scope reruns, if the active policy keeps `test` downstream of `code`, run `build-review-context` for reusable upstream `code` review first so the current-cycle reuse receipt exists before launching `test` review.'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/90-skill-catalog.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/90-skill-catalog.md`,
        heading: '## Integrity Priority Rules',
        requiredSnippets: Object.freeze([
            '## Integrity Priority Rules',
            'Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
            'Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.',
            'Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
            'If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.'
        ])
    }),
    Object.freeze({
        liveRelativePath: `${bn}/live/docs/agent-rules/90-skill-catalog.md`,
        templateRelativePath: `${bn}/template/docs/agent-rules/90-skill-catalog.md`,
        heading: '## Enforcement',
        requiredSnippets: Object.freeze([
            'Missing task-mode entry artifact (`runtime/reviews/<task-id>-task-mode.json`) blocks progression.',
            'Missing rule-pack artifact (`runtime/reviews/<task-id>-rule-pack.json`) blocks progression.',
            'Missing baseline `RULE_PACK_LOADED` blocks preflight.',
            'Missing post-preflight rule-pack proof blocks compile/review/completion.',
            'Missing `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, or `SKILL_REFERENCE_LOADED` blocks completion for code-changing tasks.',
            'Incomplete task timeline evidence is surfaced by `status` and `doctor`.'
        ])
    })
    ]);
    return _cachedMigrations;
}
