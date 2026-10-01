# T-151-1: task context audit and working plan

This is the analysis contract for T-151-2 through T-151-4. T-151-1 changes documentation and a measurement fixture only. The proposed read recipes below do not waive the current full resume protocol, alter runtime policy, authorize edits, or satisfy lifecycle gates.

Baseline: commit `046596cc2d0eee0907988559ebdb079f8fdd524e`, measured `2026-10-01T16:31:15.514Z`. [task-resume-context-baseline.json](task-resume-context-baseline.json) contains source hashes, units, observations and controlled presentation fixtures. The controller for this audit uses Codex through root `AGENTS.md`, balanced profile, and current selected `node-backend` and `testing-strategy` skills. Required reviews are code, security and performance in strict sequence.

The baseline predates the separate docs-only suite-binding repair in commit `c2e0626e1e0191a51e8710f6b0e17ff80bd394d6`. That repair also updated live project memory and regenerated its rule summary. Instruction-file footprints therefore describe the dated captured bytes, verified against an archived copy; they are not a post-repair measurement of live instructions. The selected preprompt source/module hashes and presentation fixtures can be checked separately without certifying the entire current runtime.

## Source findings

References identify the implementation at the baseline commit; top-level `preprompt-*.ts` files are compatibility facades for `src/cli/commands/preprompt/`.

| Surface | Exact owner and finding |
| --- | --- |
| Brief construction | [buildTaskBrief](../src/cli/commands/preprompt/preprompt-task-context.ts#L928) reads queue/workspace/artifact diagnostics and always constructs startup commands at line 1021. `commands.startup_pending` does not suppress them. JSON uses schema version 2. |
| Command guidance | [buildStartupCommands](../src/cli/commands/preprompt/preprompt-task-commands.ts#L145) builds six startup commands. [buildPostImplementationCommands](../src/cli/commands/preprompt/preprompt-task-commands.ts#L191) builds a compile/review/closeout list from available artifacts and alphabetically sorted required lanes. Neither list is the current validated navigator decision or the complete one-shot reviewer launch protocol. |
| Text output | [formatTaskBriefText](../src/cli/commands/preprompt/preprompt-task-format.ts#L22) always prints memory guidance and, at line 68, `StartupCommands`. Completed-task output can therefore suggest replaying startup work. |
| Historical stage | [readTaskTimelineEvents](../src/cli/commands/preprompt/preprompt-task-context.ts#L410) reads the whole timeline, ignores malformed lines and retains uppercase event types without outcome/cycle/integrity bindings. [inferCurrentStage](../src/cli/commands/preprompt/preprompt-task-context.ts#L900) selects the highest historical PASS presence using `includes`; a later restart does not invalidate it. It is descriptive legacy output, insufficient execution authority. |
| Artifact inventory | [listTaskArtifacts](../src/cli/commands/preprompt/preprompt-task-context.ts#L373) bounds a modification-time-sorted inventory to 12 task-prefixed paths. [readJsonArtifactIfExists](../src/cli/commands/preprompt/preprompt-task-context.ts#L122) checks existence/parsing, optionally hashes bytes, but does not authenticate overall currentness. Inventory presence and modification time cannot select a phase. |
| Memory guidance | [buildProjectMemoryBrief](../src/cli/commands/preprompt/preprompt-task-context.ts#L288) always emits README/compact pointers and startup diagnostics. [inferProjectMemorySuggestedFileNames](../src/cli/commands/preprompt/preprompt-task-context.ts#L215) suggests up to four topic-related files. Emitted pointers are not evidence that the client read those files. |
| Existing rule-load receipt | [readRulePackStageFilesFromPayload](../src/cli/commands/preprompt/preprompt-task-commands.ts#L71) reuses persisted paths. A prior `RULE_PACK_LOADED` receipt proves the earlier lifecycle action, not that a fresh resumed agent knows the instructions. |
| Resume requirements | [80-task-workflow, Task Resume Protocol](../garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md#L69) and [orchestration, Task Resume Protocol](../garda-agent-orchestrator/live/skills/orchestration/SKILL.md#L92) currently require full workflow rereading and current evidence before edits. [start-task routing](../.agents/workflows/start-task.md) retains canonical navigation and exact fresh-reviewer launch/receipt rules. |

The four event-array probes in the JSON demonstrate the legacy function returning `compiled`, `completion_passed`, `review_passed`, and `compiled` despite later restart/new-entry/review events. They are source-function probes, not persisted lifecycle fixtures. In particular, `REVIEW_RECORDED` alone has no outcome; the probe named `compile_then_failed_review` does not establish an authenticated failed review.

## Decision authority and currentness

T-151-2 should consume the same read-only [resolveNextStep](../src/gates/next-step/next-step.ts#L5310) query as execution. Its [resolution wrapper](../src/gates/next-step/next-step.ts#L5263) uses contained roots and workspace, timeline, review-artifact and task-index read snapshots. [createNextStepResolutionContext](../src/gates/next-step/next-step-resolution-context.ts#L69) and [readNextStepReadinessArtifacts](../src/gates/next-step/next-step-readiness-readers.ts#L47) reconstruct current task evidence. The coordinator at [resolveNextStepDecisionRoute](../src/gates/next-step/next-step.ts#L2602) supplies authenticated decisions to the [immutable checkpoint projection](../src/gates/next-step/next-step-decision-engine.ts#L84).

Projection immutability alone does not authenticate caller-created evidence. Reuse the shared resolution boundary; do not create another stage engine, trust arbitrary projected objects, spawn gate subprocesses while building a brief, or execute planned effects. `executeNextStepEffects` is a separate explicit mutation path. Guidance remains advisory: run `next-step` immediately before the next action and after it; an earlier brief cannot authorize a later action after workspace drift.

| Currentness input | Required treatment in the future recipe |
| --- | --- |
| Task identity and roots | Canonical current row, selected provider route, contained artifact paths; foreign/unknown identities cannot yield an edit shortcut. |
| Frozen start/profile/plan | Current task-mode and frozen policy/plan bindings; mutable live profile or plan text cannot replace the current immutable snapshot. Changed/missing attachments route through existing diagnostics. |
| Source and preflight | Current workspace scope/content and preflight hashes, including protected paths; stale evidence triggers navigator refresh. Filename matches, timestamps or task status alone are insufficient. |
| Compile, suite and reviews | Current scope/cycle and dependency bindings, exact launch input and invocation receipts; historical PASS events cannot satisfy current readiness. Honor existing authenticated docs-only suite decisions. |
| Failed-review remediation | Current findings receipt, locked disposition and authenticated allowed scope. [resolveAuthenticatedFixNowRemediationState](../src/gates/next-step/next-step-post-review-source-mutation-guard.ts#L55) owns that check. An old FAIL/PASS or a bare finding cannot authorize edits. |
| Unknown, stale, unreadable or conflicting state | Emit bounded diagnostics and a sufficient full-context fallback; retain the current navigator blocker. Never invent a phase, omit mandatory instructions, or replay an unconditional command list. |

## Controller versus fresh reviewer

| Input | Controller | Fresh required reviewer |
| --- | --- | --- |
| Repository routing/rules | Root routing, core constraints, canonical workflow and phase-relevant recorded controller rules. [TASK_ENTRY selection](../src/gates/rule-pack/rule-pack-selection.ts#L46) and [POST_PREFLIGHT selection](../src/gates/rule-pack/rule-pack-selection.ts#L142) are controller contracts. | Actual repository rule selection is **empty**: [getRulePack](../src/gates/review-context/review-context-token-economy.ts#L54) returns empty `full`, `depth1` and `depth2` lists. Pure probes confirm zero for code/security/performance/test. Do not copy controller rule books into the reviewer. |
| Skills | Current selected implementation skills and references when implementation is needed; lifecycle activation requirements still apply. This audit selected `node-backend` and `testing-strategy`. | Mandatory selected lane skill and its relevant references from the immutable current-task review snapshot and generated handoff. Built-in examples: `code-review`, `security-review`, `performance-review`; optional/custom lanes retain their resolved skills. Empty repository rules do not mean an empty reviewer prompt. |
| Memory | Current README then compact under existing policy; focused `commands`, `module-map`, `risks` or `decisions` only when the task needs them. Closeout uses current impact decisions. | Relevant source/task facts supplied by the generated handoff; no unconditional controller-memory reread. The reviewer follows references required by its selected skill and authenticated scope. |
| Artifacts | Current navigator diagnostics, preflight/compile/suite and upstream review receipts, locked findings, impact/completion/report state. Successful review handoffs remain opaque to the implementation agent. | Immutable preflight/scope/diff/tree/policy bindings, selected skill/reference files, generated role/prompt/output templates and coverage contract, exact launch-input hash/attempt, required upstream evidence and named validation logs. |
| Isolation and receipts | Build context, record routing, prepare launch, then spawn a new clean-context reviewer with the exact generated input. Immediately record actual delegation start; after return, finalize launch and record result. Release the session. | One current review invocation, no inherited implementation conversation, no earlier reserved reviewer, no session reuse, no gate execution, and exactly the generated findings-only output contract. |

The orchestration skill's [Token Economy prose](../garda-agent-orchestrator/live/skills/orchestration/SKILL.md#L47) still describes older reviewer repository packs. That prose differs from the actual empty selection above. T-151-3 must reconcile relevant resume guidance with the real contract; T-155 owns broad generated-entrypoint/bridge duplication. Preserve the selected reviewer skill and launch trust evidence throughout.

## Proposed minimum controller reads by phase

These are implementation specifications for later children, **not currently effective replacement instructions**. Every proposed phase includes current root routing, `00-core.md`, the current `TASK.md` row, and current validated navigator diagnostics. A new agent actually reads the selected instructions; old rule-load evidence cannot stand in for that read. Canonical paths below are relative to `garda-agent-orchestrator/live/`: rules are `docs/agent-rules/`, memory is `docs/project-memory/`, and skills are `skills/<id>/SKILL.md` with selected references.

| Phase selected by validated remaining work | Additional controller reads | Evidence and reload boundary |
| --- | --- | --- |
| Fresh start | Shared start-task router; full orchestration start workflow; TASK_ENTRY rules `00`, `15`, `40`, `80`, `90`; memory README then compact; applicable selected skills and references. | Current start/profile/plan/identity/scope diagnostics and optional-skill selection. No blanket command replay: execute only the next current navigator action. |
| Implementation resume | Orchestration resume/implementation rules; `40-commands`; applicable architecture, code/style/strict and security rules; current selected implementation skills/references; focused memory. | Current task-mode/preflight/plan and allowed implementation scope; load corresponding instructions before each newly requested kind of edit. |
| Test or review work only | Canonical compile/suite and review protocol, `80`/`90` trust and routing sections, exact launch/receipt protocol; selected validation instructions when running tests. | Current compile/suite/preflight bindings and upstream receipts. Previously satisfied activation/gates remain enforced. Omit framework implementation material only while no source edit is required and evidence is current; a test/source fix reloads implementation context first. |
| Documentation/memory closeout | `80` documentation, memory and approval rules plus `15` memory policy; affected documentation; README/compact and focused memory when maintenance is required. | Current doc-impact/memory decisions and reviewed scope. Protected memory/control-plane writes retain their approval boundary. A behavior-changing fix returns to implementation rules and refreshed evidence. |
| Completion/final report | `80` completion, task audit, generated report and commit rules; current final artifacts. | Current completion/audit/report bindings; preserve verbatim generated report ordering. No prior DONE/status/PASS shortcut; new edits require the implementation recipe and normal gates. |
| Failed-review remediation | Full failed-review/remediation and implementation instructions; `40`; applicable code/risk rules and selected skills/references; focused memory for the actual fix. | Current accepted findings and locked disposition, allowed fix scope and review lineage. Run the existing navigator recovery chain; regenerate fresh reviewer handoffs when required. |

The optimization reduces irrelevant *controller reads* after verified phase selection. It must not suppress a gate, skip applicable selected skills, change review order, or permit unknown state to select a smaller read set. No manual phase toggle, separate handoff system or new approval mechanism is planned.

## Measured baseline and its limits

The real CLI was invoked in text and JSON modes for three existing states; each mode uses a separate read-only process. Units are UTF-8 bytes and JavaScript UTF-16 code units, including stdout's trailing newline.

| Sample | Text bytes / characters | JSON bytes / characters | Exit codes text / JSON | Startup commands | Read-only navigator |
| --- | --- | --- | --- | --- | --- |
| T-151-2, unstarted while T-151-1 is active | 4,574 / 4,574 | 11,150 / 11,148 | 3 / 3 | 6 | BLOCKED, `enter-task-mode`, confirmation alongside unfinished task |
| T-151-1, planned audit scope | 6,052 / 6,052 | 21,039 / 21,037 | 0 / 0 | 6 | BLOCKED, `materialize-planned-scope` |
| T-150-4, completed | 6,419 / 6,419 | 18,832 / 18,830 | 0 / 0 | 6 | DONE, no next gate or command |

The first sample's exit 3 is the preprompt diagnostic for mandatory optional-skill selection: no installed specialist selected (`low_confidence_match`), no materialized selection artifact/current preflight. It is not a successful fresh-start readiness check. Its separate navigator blocker concerns the unfinished task; those diagnostics must not be conflated. The measurement harness exited 0 because it recorded these outcomes, not because all CLI probes passed.

The hashes of 76 watched lifecycle files were identical before and after the probes: `40226da775be276eef5a17306cb4f5a58bc5f50494b45eedb445d3981d317c43`. Scope: `TASK.md`, workflow/profile config, and the three tasks' canonical review artifacts/timelines. This is not an exhaustive filesystem-write trace, nor proof of every future input's read-only behavior.

The following before values are baseline formatter output for a controlled presentation fixture based on the T-151-1 brief. Only its phase label/startup flag/post-implementation list are varied. They are **not authenticated persisted phases**. The draft after values serialize a small proposed read-recipe pointer; they omit much of the existing brief and are **not implemented CLI output or equivalent verified lifecycle behavior**.

| Controlled presentation | Before bytes / characters | Draft after bytes / characters |
| --- | --- | --- |
| Fresh start | 4,286 / 4,286 | 459 / 459 |
| Implementation resume | 6,057 / 6,057 | 486 / 486 |
| Test/review only | 6,052 / 6,052 | 495 / 495 |
| Documentation/memory closeout | 6,056 / 6,056 | 530 / 530 |
| Completion/final report | 6,059 / 6,059 | 457 / 457 |
| Failed-review remediation | 6,061 / 6,061 | 530 / 530 |

The JSON retains a single formatter-input snapshot and the exact draft strings for reproduction. `ceil(characters / 4)` is a rough estimate only, with no tokenizer or usage measurement. Actual client-loaded instructions and actual token usage are **unmeasured**; no realized savings percentage follows from this table. The 16 instruction-file footprints measure complete source-file bytes, not actual client loads or reads prompted by pointers. Referenced skill checklists are required when applicable but their byte costs are not included in that inventory.

Current materialization defaults are selected-provider emission: [init](../src/materialization/init.ts#L38) sets `providerMinimalism=true`, `activeAgentFilesSeed=null`; [getActiveAgentEntrypointFiles](../src/materialization/common.ts#L60) yields only `AGENTS.md` for the default Codex selection ([default source](../src/core/constants.ts#L191)). Extra provider entries can be explicitly selected. This is an entrypoint-selection observation, not total installation size, automatic client-loading evidence, or a native discovery certification. Legacy all-provider installation size is unmeasured here and is not the current default context cost.

## Bounded implementation and validation plan

| Owner | Concrete work and completion evidence |
| --- | --- |
| T-151-2 | Reuse shared validated read-only navigation in preprompt; expose bounded current action, remaining-work/read-set hints and explicit unknown/stale diagnostics. Preserve existing output compatibility through versioned additive fields or a documented compatible presentation change; inspect current callers first. No effects, gate subprocesses or second phase engine. Keep JSON/text task identity and diagnostics aligned. |
| T-151-3 | Update canonical controller resume guidance around validated remaining work and actual reads, with sufficient fallback and implementation reload before edits. Preserve current core constraints, selected skills, review order, protected approval boundaries, one-shot fresh-reviewer launch and receipt protocol, and generated final-report ordering. Reconcile reviewer-rule prose with the empty actual selection without removing lane skills. |
| T-151-4 | Exercise actual authenticated fresh/resumed/test-review/closeout/completion/remediation transitions, not just phase-label fixtures. Measure new CLI bytes, instruction reads observed by an available client separately, and unavailable token usage honestly. Cover controlled stale/foreign/tampered evidence, old PASS followed by restart/new entry, equal timestamps, plan tampering, requested edits during late phases, read-only state hashes and zero startup replay. Include selected-default and explicitly legacy provider scenarios only where this child's TASK scope requires; preserve template contracts and split before exceeding its file budget. |
| T-155 boundary | Reuse this baseline and implemented T-151 phase semantics to shorten generated entrypoint/bridge prose. Keep native frontmatter/import behavior, user content, selected-provider defaults, trust/gates/launch and report contracts. Measure generated bytes and actual client instruction loads separately for selected-provider and legacy scenarios; do not redesign resume selection. |

Existing test entry points for regression expansion: [preprompt startup/scope output](../tests/node/cli/commands/preprompt-command-startup-commands.test.ts#L35), [startup currentness](../tests/node/gates/next-step/next-step-startup-routing.test.ts#L32), [decision projection](../tests/node/gates/next-step/next-step-decision-engine.test.ts#L86), [stale/unauthorized fixes](../tests/node/gates/next-step/next-step-post-review-source-mutation-guard.test.ts#L286), [launch-input tampering](../tests/node/gates/next-step/next-step-reviewer-launch-evidence.test.ts#L410), and [failed-review restart routing](../tests/node/gates/next-step/next-step-review-failure-routing.test.ts#L3917). These references are research inputs, not claims that T-151-1 ran those tests. Each child follows its current TASK file budget and mandatory navigator gates; split coherent work before exceeding the budget.

## Reproduction

For new real CLI observations, run `node bin/garda.js preprompt task --task-id <id> --target-root .` and its `--json` variant with bounded captured stdout, preserving each exit code. Record `Buffer.byteLength(stdout, 'utf8')`, `stdout.length` and SHA-256; separately query `resolveNextStep({repoRoot, taskId})` without effects. Hash the named lifecycle files before and after. Record the commit, evidence state, runtime provenance and diagnostic outcomes: different task state legitimately produces different output. Rebuild through the repository's normal workflow if compiled modules are stale.

The recorded presentation fixture can be reproduced with the baseline-commit compiled formatter, independently of mutable current task artifacts:

```javascript
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { formatTaskBriefText } = require('../.node-build/src/cli/commands/preprompt/preprompt-task-format.js');
const b = JSON.parse(fs.readFileSync('docs/task-resume-context-baseline.json', 'utf8'));
const metric = s => ({ utf8_bytes: Buffer.byteLength(s, 'utf8'), utf16_chars: s.length,
  token_estimate_chars_div_4: Math.ceil(s.length / 4),
  sha256: crypto.createHash('sha256').update(s).digest('hex') });
for (const s of b.bounded_phase_presentation_scenarios) {
  const input = { ...b.presentation_input, task: { ...b.presentation_input.task, current_stage: s.phase },
    commands: { ...b.presentation_input.commands, startup_pending: s.phase === 'fresh_start',
      post_implementation_commands: s.phase === 'fresh_start' ? [] : b.presentation_input.commands.post_implementation_commands } };
  assert.deepEqual(metric(formatTaskBriefText(input)), s.before);
  assert.deepEqual(metric(s.draft_text), s.after);
}
```

Save this reproduction script under `docs/` and run it from the repository root; it is ordinary fixture validation, not gate evidence. T-151-1's selected validation logs separately record actual outcomes. No audit document, fixture, hash equality or byte reduction can replace required compile, suite, independent review, impact, completion or task-audit evidence.
