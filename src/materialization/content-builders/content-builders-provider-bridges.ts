import { resolveBundleName } from '../../core/constants';
import {
    buildDualCliActiveProfileGuidance,
    buildNextStepNavigatorGuidance,
    buildTaskStartNavigatorPrompt
} from '../../core/onboarding-contract';
import {
    buildFreshMainAgentStartBannerSentence,
    START_BANNER_GATE_LIST_RULE,
    START_BANNER_EXEMPTION_RULE
} from '../../core/orchestrator-start-banner';
import { getRequiredProviderEntryByBridgePath } from '../../core/provider-registry';
import {
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION,
    REVIEWER_DELEGATION_STARTED_INSTRUCTION,
    REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
    REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION
} from '../../gate-runtime/reviewer-session-contract';
import { getNodeGateCommandPrefix } from '../command-constants';
import {
    ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION,
    buildBundleNextStepSnippet,
    buildSourceNextStepSnippet,
    buildTaskStartSnippetSection,
    getDelegationRequiredProviderLaunchLines,
    getReviewSkillBridgeHost,
    MANAGED_END,
    MANAGED_START,
    OPTIONAL_MARKDOWN_WORKING_PLAN_INSTRUCTION,
    REVIEW_LAUNCH_NAVIGATION_INSTRUCTION
} from './content-builders-shared';

const PHASE_SCOPED_RESUME_GUIDANCE = `## Phase-Scoped Resume Context
- Use the advisory \`context_selection.controller_read_set\` from \`preprompt task\` for the current continuation phase. Keep canonical routing, core rules, the current task row and Notes, frozen attached-plan criteria, and required linked references.
- Before acting, rerun \`context_selection.navigator_command\`; unknown or stale navigator state requires implementation context. A missing section requires the full source and implementation instructions before continuing.
- Before any source or test edit, load the complete \`before_code_edit_read_set\` and the selected implementation skills with their required references. Historical \`RULE_PACK_LOADED\` evidence is not current session knowledge.
- Fresh reviewer repository-rule read sets remain empty. Launch a fresh isolated reviewer with the exact prepared launch input; preserve its required skills, generated context, scoped diff, and evidence.
- Preserve scope, approvals, mandatory gates, compile and suite validation, reviewer launch and receipt checks, and the canonical audit and verbatim final-report order.`;

export function buildProviderOrchestratorAgentContent(
    providerLabel: string,
    canonicalFile: string,
    bridgePath: string
): string {
    void providerLabel;
    const providerEntry = getRequiredProviderEntryByBridgePath(bridgePath);
    const runtimeProviderLabel = providerEntry.displayLabel;
    const runtimeIdentityInstruction = `pin runtime identity with ` +
        `\`--provider "${runtimeProviderLabel}"\` and optionally \`--routed-to "${bridgePath}"\` when route telemetry must be pinned`;
    if (providerEntry?.bridge?.profileVariant === 'compact_router') {
        return `${MANAGED_START}
# ${runtimeProviderLabel} Agent: Orchestrator

Canonical source of truth for agent workflow rules: \`${canonicalFile}\`.

This bridge is a router, not a second workflow.
Do not implement tasks directly without orchestration preflight and required review gates.
If the workspace already contains modified files before task-mode entry, stop and isolate scope via \`--use-staged\` or explicit \`--changed-file ...\` preflight inputs before continuing.

Required:
1. Open \`${canonicalFile}\`, \`TASK.md\`, and \`.agents/workflows/start-task.md\`.
2. Start every task with ${buildTaskStartNavigatorPrompt()}
3. ${buildFreshMainAgentStartBannerSentence()}
4. ${START_BANNER_GATE_LIST_RULE}
5. Run \`${buildBundleNextStepSnippet()}\` as the default task loop in deployed workspaces, or \`${buildSourceNextStepSnippet()}\` in this source checkout; rerun the same command after every suggested command.
6. Follow the shared checklist in \`.agents/workflows/start-task.md\` exactly.
7. ${buildDualCliActiveProfileGuidance(null)}
8. Use compact command protocol from \`40-commands.md\`: first \`scan\`, then \`inspect\`, then verbose \`debug\` only by exception.
9. Do not bypass gates, fake review artifacts, or use provider-default review flow outside Garda.
10. ${REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION}
11. ${ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION}
12. Mandatory reviews on this provider must preserve \`delegated_subagent\` reviewer execution; same-agent self-review is invalid and stale fallback metadata cannot satisfy a fresh cycle.
13. ${REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION}
14. ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}
15. Do not launch a dependent downstream reviewer before the required upstream accepted findings receipt reports findings-satisfied for the same cycle. Parallel reviewer fan-out is allowed only between independent review types with no dependency edge.
16. ${REVIEW_LAUNCH_NAVIGATION_INSTRUCTION}
17. Do not fan out known producer-consumer validation commands as raw shell sidecars. Flows such as \`npm run build:node-foundation\` -> direct \`node --test .node-build/...\` must use the guarded workflow path or run strictly sequentially, never in parallel.
18. If any mandatory gate command fails, stop, keep the task blocked, run \`next-step\`, and report the exact command, cwd, CLI path, and stderr.
19. Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.
20. Mandatory gate failure means stop or \`BLOCKED\`; never workaround the gate, batch around it, or synthesize missing evidence.
21. Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.
22. Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.
23. If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.

${PHASE_SCOPED_RESUME_GUIDANCE}

${buildTaskStartSnippetSection(runtimeProviderLabel, bridgePath)}

Canonical workflow skill: \`${resolveBundleName()}/live/skills/orchestration/SKILL.md\`
Skill catalog: \`${resolveBundleName()}/live/docs/agent-rules/90-skill-catalog.md\`
Bridge path: \`${bridgePath}\`
${MANAGED_END}`.trim();
    }

    return `${MANAGED_START}
# ${runtimeProviderLabel} Agent: Orchestrator

Canonical source of truth for agent workflow rules: \`${canonicalFile}\`.

Hard stop: first open \`${canonicalFile}\`, \`TASK.md\`, and \`.agents/workflows/start-task.md\`.
Do not implement tasks directly without orchestration preflight and required review gates.
Canonical task-start command: ${buildTaskStartNavigatorPrompt()}
${buildFreshMainAgentStartBannerSentence()}
${START_BANNER_GATE_LIST_RULE}
If the workspace already contains modified files before task-mode entry, stop and isolate scope via \`--use-staged\` or explicit \`--changed-file ...\` preflight inputs before continuing.
Ignored orchestration control-plane files (for example \`TASK.md\`, \`${resolveBundleName()}/runtime/**\`, and \`${resolveBundleName()}/live/docs/changes/CHANGELOG.md\`) are expected local artifacts; never \`git add -f\` them unless the user explicitly asks to version orchestrator internals.
This provider profile is a strict bridge to Garda skills and the Node gate router.
Treat \`.agents/workflows/start-task.md\` as the shared router for every provider surface; it routes to canonical orchestration and does not replace \`80-task-workflow.md\`.
Use compact command protocol from \`40-commands.md\`: first \`scan\`, then \`inspect\`, then verbose \`debug\` only by exception.
Do not execute task or review workflow with provider-default reviewer agents that bypass this bridge.
Use \`${buildBundleNextStepSnippet()}\` as the default task loop in deployed workspaces, or \`${buildSourceNextStepSnippet()}\` in this source checkout. Run it before the first gate, after every suggested command, and after any gate failure.

${PHASE_SCOPED_RESUME_GUIDANCE}

## Non-Negotiable Priorities
- Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.
- Mandatory gate failure means stop or \`BLOCKED\`; never workaround the gate, batch around it, or synthesize missing evidence.
- Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.
- Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.
- If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.

${buildTaskStartSnippetSection(runtimeProviderLabel, bridgePath)}

## Required Execution Contract
1. Read \`${canonicalFile}\` and its routing links before making changes.
2. Read \`TASK.md\` and select/create a task row before implementation.
3. Execute task workflow only in orchestrator mode: ${buildTaskStartNavigatorPrompt()}
4. ${buildFreshMainAgentStartBannerSentence()}
5. ${START_BANNER_GATE_LIST_RULE}
6. Use \`${buildSourceNextStepSnippet()}\` in a self-hosted source checkout, or \`${buildBundleNextStepSnippet()}\` inside a materialized/deployed workspace, as the command navigator before every numbered gate below.
7. ${OPTIONAL_MARKDOWN_WORKING_PLAN_INSTRUCTION}
8. ${buildDualCliActiveProfileGuidance(null)}
9. If the workspace already contains modified files before task-mode entry, stop and isolate scope via \`--use-staged\` or explicit \`--changed-file ...\` preflight inputs before continuing.
10. Enter task mode explicitly only when \`next-step\` tells you to do so: via \`node bin/garda.js gate enter-task-mode ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} enter-task-mode ...\` inside a materialized/deployed workspace; ${runtimeIdentityInstruction}.
11. Record baseline downstream rules explicitly when \`next-step\` requests it: via \`node bin/garda.js gate load-rule-pack ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} load-rule-pack ...\` inside a materialized/deployed workspace.
12. Run handshake diagnostics when requested by \`next-step\`: via \`node bin/garda.js gate handshake-diagnostics ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} handshake-diagnostics ...\` inside a materialized/deployed workspace.
13. Run shell smoke preflight when requested by \`next-step\`: via \`node bin/garda.js gate shell-smoke-preflight ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} shell-smoke-preflight ...\` inside a materialized/deployed workspace.
14. Run preflight classification before implementation when requested by \`next-step\`: via \`node bin/garda.js gate classify-change ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} classify-change ...\` inside a materialized/deployed workspace.
15. After preflight, refresh downstream rule-pack evidence when requested by \`next-step\`: via \`node bin/garda.js gate load-rule-pack --stage "POST_PREFLIGHT" ...\` when rules must be read, or \`node bin/garda.js gate bind-rule-pack-to-preflight ...\` when \`next-step\` says current-cycle rule files and hashes are already loaded. Use the matching \`${getNodeGateCommandPrefix()}\` command inside a materialized/deployed workspace, and preserve any custom \`--task-mode-path\` on both POST_PREFLIGHT rule-pack commands.
16. Run compile gate before review only after \`next-step\` reports it as the next gate: via \`node bin/garda.js gate compile-gate ...\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} compile-gate ...\` inside a materialized/deployed workspace.
17. Before each required review, run \`node bin/garda.js gate build-review-context ...\` in a self-hosted source checkout, or \`${getNodeGateCommandPrefix()} build-review-context ...\` inside a materialized/deployed workspace, only when \`next-step\` names that review; that step auto-emits \`REVIEW_PHASE_STARTED\`, \`SKILL_SELECTED\`, and \`SKILL_REFERENCE_LOADED\`. ${REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION} ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION} Dependent downstream review preparation or reviewer launch must wait until the required upstream accepted findings receipt reports findings-satisfied for the same cycle.
18. Do not fan out known producer-consumer validation commands as raw shell sidecars around the gate flow. Flows such as \`npm run build:node-foundation\` -> direct \`node --test .node-build/...\` must use the guarded workflow path or run strictly sequentially, never in parallel.
19. Run required independent reviews and gates via \`node bin/garda.js gate required-reviews-check ...\` in a self-hosted source checkout, or \`${getNodeGateCommandPrefix()} required-reviews-check ...\` inside a materialized/deployed workspace; only independent review types may fan out in parallel for the same cycle. If a cycle changed only test scope, materialize reusable upstream \`code\` review evidence before launching \`test\`, then run \`doc-impact-gate\`, then \`completion-gate\` before marking \`DONE\`.
20. Update task status and artifacts in \`TASK.md\`.
21. Log or inspect lifecycle events by task id via \`node bin/garda.js gate log-task-event ...\` / \`task-events-summary\` in a self-hosted source checkout, or via \`${getNodeGateCommandPrefix()} log-task-event ...\` / \`task-events-summary\` inside a materialized/deployed workspace.

## Reviewer Launch Mapping (Mandatory Delegation)
- Every provider must spawn each required reviewer as a fresh-context sub-agent; same-agent self-review is invalid for mandatory reviews.
${getDelegationRequiredProviderLaunchLines().join('\n')}
- Routing and prepare may use only the planned \`agent:pending:<task-id>-<review-type>\` identity; record the resolved provider \`agent:*\` identity only with \`record-reviewer-delegation-started\` after the real reviewer launch.
- Providers or bridges without delegated reviewer support are not eligible to satisfy the mandatory review workflow until delegated launch support exists.
- ${REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION}
- ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}
- Dependency order is a launch-time contract even on delegation-capable platforms: do not launch a dependent downstream reviewer before the required upstream accepted findings receipt reports findings-satisfied for the same cycle.
- Parallel reviewer fan-out is allowed only between independent review types with no dependency edge for the current cycle.
- ${REVIEW_LAUNCH_NAVIGATION_INSTRUCTION}
- Each review receipt must include \`reviewer_execution_mode\` (\`delegated_subagent\`) and \`reviewer_identity\` (\`agent:...\`). Receipts that do not preserve this delegated reviewer contract cannot satisfy a fresh mandatory review cycle.

## Skill Routing
- Orchestration: \`${resolveBundleName()}/live/skills/orchestration/SKILL.md\`
- Code review: \`${resolveBundleName()}/live/skills/code-review/SKILL.md\`
- DB review: \`${resolveBundleName()}/live/skills/db-review/SKILL.md\`
- Security review: \`${resolveBundleName()}/live/skills/security-review/SKILL.md\`
- Refactor review: \`${resolveBundleName()}/live/skills/refactor-review/SKILL.md\`

## Dynamic Skill Discovery (Required)
- Canonical skill list: \`${resolveBundleName()}/live/docs/agent-rules/90-skill-catalog.md\`
- Optional-skill capability flags: \`${resolveBundleName()}/live/config/review-capabilities.json\`
- Optional review-lane declarations: \`${resolveBundleName()}/live/config/review-catalog.json\` (absence remains legacy-compatible)
- Profile lane states and dependency graphs: \`${resolveBundleName()}/live/config/profiles.json\`
- Token-economy controls: \`${resolveBundleName()}/live/config/token-economy.json\`
- Output-filter profiles: \`${resolveBundleName()}/live/config/output-filters.json\`
- Include specialist skills added after initialization from \`${resolveBundleName()}/live/skills/**\` when required by preflight and capability flags.
- During normal task execution, use the immutable current-task catalog/policy snapshot and generated reviewer launch input; do not load the full catalog into agent context. Use \`review-catalog list|show|explain|validate\` only for explicit inspection or management work.

## Task Timeline Logging (Required)
- Event logger: \`${getNodeGateCommandPrefix()} log-task-event ...\`
- Log file (per task): \`${resolveBundleName()}/runtime/task-events/<task-id>.jsonl\`
- Aggregate log: \`${resolveBundleName()}/runtime/task-events/all-tasks.jsonl\`

Bridge path for this provider: \`${bridgePath}\`.
${MANAGED_END}`.trim();
}

export function buildSharedStartTaskWorkflowContent(canonicalFile: string): string {
    const runtimeProviderPlaceholder = '<runtime-provider>';
    const routePlaceholder = '<provider-bridge-or-entrypoint>';
    return `${MANAGED_START}
---
description: "Mandatory shared router for any task execution through Garda orchestration."
---

# Start Task

This checklist is the shared start-task router for root entrypoints and provider bridges.
It routes to the canonical Garda workflow and does not replace \`80-task-workflow.md\` or the orchestration skill.

Before any code changes:
- Open \`${canonicalFile}\` and \`TASK.md\`.
- If an active provider bridge exists, open it too before implementation.
- ${buildFreshMainAgentStartBannerSentence()}
- ${START_BANNER_GATE_LIST_RULE}
- ${START_BANNER_EXEMPTION_RULE}
- Enter orchestrator mode with the canonical command: ${buildTaskStartNavigatorPrompt()}
- ${buildNextStepNavigatorGuidance('node bin/garda.js')} In deployed workspaces use \`${buildBundleNextStepSnippet()}\`.
- Do not start by guessing \`compile-gate\`, \`classify-change\`, or default config flags. Static gate order below is policy context; \`next-step\` is the executable navigator.
- ${OPTIONAL_MARKDOWN_WORKING_PLAN_INSTRUCTION}
- ${buildDualCliActiveProfileGuidance(null)}
- If the workspace already contains modified files before task-mode entry, stop and isolate scope via \`--use-staged\` or explicit \`--changed-file ...\` preflight inputs before continuing.
- Agents cannot approve protected task-mode entry for themselves. Any rerun with \`--orchestrator-work\` or \`--workflow-config-work\` requires a fresh operator approval, \`--operator-confirmed yes\`, and \`--operator-confirmed-at-utc "<ISO-8601 timestamp>"\`.
- In materialized/application workspaces, the Garda bundle is vendor/control-plane. When \`garda_self_guard\` is on, agents must not self-escalate into \`--orchestrator-work\`; route protected Garda bundle edits to operator-owned update/repair/maintenance or an explicit \`workflow set --garda-self-guard off\` policy change.
- Use compact command protocol from \`40-commands.md\`: first \`scan\`, then \`inspect\`, then verbose \`debug\` only by exception.

${buildTaskStartSnippetSection(runtimeProviderPlaceholder, routePlaceholder)}

Mandatory gate order:
0. \`next-step "<task-id>"\` before the first gate and after every gate; run only the single recommended command it prints unless the user explicitly asks for diagnostics
1. \`gate enter-task-mode\` with explicit runtime identity via \`--provider "<provider>"\`; add \`--routed-to "<provider-bridge-or-entrypoint>"\` only when route telemetry must be pinned, and never rely on canonical SourceOfTruth fallback
2. \`gate load-rule-pack --stage TASK_ENTRY\`
3. \`gate handshake-diagnostics\`
4. \`gate shell-smoke-preflight\`
5. \`gate classify-change\`
6. POST_PREFLIGHT rule-pack command printed by \`next-step\`: \`gate load-rule-pack --stage POST_PREFLIGHT\` or \`gate bind-rule-pack-to-preflight\`
7. implement only after preflight
8. \`gate compile-gate\`
9. \`gate build-review-context\` for each required review
10. \`gate required-reviews-check\`
11. \`gate doc-impact-gate\`
12. \`gate full-suite-validation\` (when enabled via workflow-config.json)
13. \`gate completion-gate\`

Hard stops:
- If a mandatory gate fails or is unavailable, stop and report the exact command and stderr.
- If \`next-step\` or a failed gate says \`--orchestrator-work\`, \`--workflow-config-work\`, or \`workflow set\` is required, stop for explicit operator approval before running the command with \`--operator-confirmed yes\` and \`--operator-confirmed-at-utc "<ISO-8601 timestamp>"\` where required.
- If \`next-step\` reports \`operator-maintenance\` because Garda self-guard is on, do not rerun task mode with \`--orchestrator-work\`; an operator must run update/repair/maintenance or deliberately relax the guard.
- Do not make code edits before \`enter-task-mode\`; unscoped pre-task diffs must be isolated first.
- ${REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION}
- ${REVIEWER_DELEGATION_STARTED_INSTRUCTION}
- ${REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION}
- ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}
- Do not spawn or pre-launch a dependent downstream reviewer before the required upstream accepted findings receipt reports findings-satisfied for the same cycle.
- Parallel reviewer fan-out is allowed only between independent review types with no dependency edge.
- ${REVIEW_LAUNCH_NAVIGATION_INSTRUCTION}
- Do not fan out known producer-consumer validation commands as raw shell sidecars. Flows such as \`npm run build:node-foundation\` -> direct \`node --test .node-build/...\` must use the guarded workflow path or run strictly sequentially, never in parallel.
- Do not hand-edit active \`TASK.md\` lifecycle statuses (\`IN_PROGRESS\`, \`IN_REVIEW\`, \`DONE\`, \`BLOCKED\`) as a substitute for gates; completion finalization owns \`DONE\`, review-gate owns \`IN_REVIEW\`, task-mode owns \`IN_PROGRESS\`, and explicit operator \`task-reset\` owns reset/discard.
- Do not mark \`DONE\` without \`COMPLETION_GATE_PASSED\`.
- Do not create fake review artifacts or bypass reviewer routing.
- The \`40-commands.md\` restraint applies only to standalone ad-hoc commands. It does NOT exempt mandatory gates: gates such as \`compile-gate\` and \`full-suite-validation\` must execute their underlying build/test/type-check commands when the workflow requires them.
${MANAGED_END}`.trim();
}

export function buildGitHubSkillBridgeAgentContent(
    profileTitle: string,
    canonicalFile: string,
    skillPath: string,
    reviewRequirement: string,
    capabilityFlag: string
): string {
    const reviewSkillBridgeHost = getReviewSkillBridgeHost();
    return `${MANAGED_START}
# GitHub Agent: ${profileTitle}

Canonical source of truth for agent workflow rules: \`${canonicalFile}\`.

Hard stop: first open \`${reviewSkillBridgeHost.bridgePath}\`, \`${canonicalFile}\`, and \`TASK.md\`.
Do not implement tasks directly without orchestration preflight and required review gates.
Ignored orchestration control-plane files (for example \`TASK.md\`, \`${resolveBundleName()}/runtime/**\`, and \`${resolveBundleName()}/live/docs/changes/CHANGELOG.md\`) are expected local artifacts; never \`git add -f\` them unless the user explicitly asks to version orchestrator internals.
Use compact command protocol from \`40-commands.md\`: first \`scan\`, then \`inspect\`, then verbose \`debug\` only by exception.

## Skill Bridge Contract
- Use this profile only as a bridge to skill: \`${skillPath}\`
- Required review selector: \`${reviewRequirement}\`
- Capability flag gate: \`${capabilityFlag}\`
- Re-read \`${resolveBundleName()}/live/docs/agent-rules/90-skill-catalog.md\` before execution.
- Re-read \`${resolveBundleName()}/live/config/review-capabilities.json\` before execution.
- Resolve review lanes from the current generated launch input and immutable task snapshot; do not load the full review catalog into reviewer context.
- Re-read \`${resolveBundleName()}/live/config/token-economy.json\` before execution.
- Re-read \`${resolveBundleName()}/live/config/output-filters.json\` before execution.
- Keep downstream rule-pack evidence current via \`${getNodeGateCommandPrefix()} load-rule-pack ...\`; bridge execution is invalid without recorded rule-file loading.
- Reviewer preparation must run \`${getNodeGateCommandPrefix()} build-review-context --review-type "<review-type>" ...\` before findings-result capture; completion for code-changing tasks validates the resulting review-skill telemetry.
- Downstream \`test\` review must wait for current-cycle accepted findings receipts with findings-satisfied state from required upstream non-\`test\` reviews; on pure test-scope reruns, materialize reusable upstream \`code\` review evidence first.
- On \`${reviewSkillBridgeHost.providerLabel}\`, spawn reviewer helper tasks via \`task\` tool with \`agent_type="general-purpose"\` and isolated context; same-agent self-review is invalid on this delegation-capable provider. ${REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION}
- ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}
- Honor specialist skills added after initialization under \`${resolveBundleName()}/live/skills/**\`.
- Record review routing and outcomes only through the review gates; \`log-task-event\` cannot emit reviewer provenance events.
- Task timeline path (per task): \`${resolveBundleName()}/runtime/task-events/<task-id>.jsonl\`.
- Validated findings, system-derived lane state, and completion status are recorded only through orchestrator workflow.
- Never mark task \`DONE\` from this profile; hand off to \`${reviewSkillBridgeHost.bridgePath}\`.
${MANAGED_END}`.trim();
}
