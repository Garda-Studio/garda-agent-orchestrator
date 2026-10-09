# Provider Compatibility Matrix

Structural status badges: **✅ Fixture coverage** · **🟡 Partial** · **🔬 Experimental** · **— Not applicable**

The structural matrices describe Garda registry, generated-text and gate fixtures.
They do not certify native instruction loading, client authentication or fresh
reviewer launch on every CLI, IDE, desktop or cloud surface. Documentation is
separate evidence: see the dated [client contract and probe matrix](provider-client-evidence.md#dated-native-contract-matrix).
For a shorter human-readable list, see [Supported Providers](providers.md).

## Garda Materialization Overview

| Provider | Entrypoint | Bridge Profile | Config Bootstrap |
|---|---|---|---|
| Claude | `CLAUDE.md` | — | `.claude/settings.local.json` |
| Codex | `AGENTS.md` | — | — |
| Cursor | `AGENTS.md` (shared with Codex) | — | — |
| DeepSeek | `AGENTS.md` (shared model-provider entrypoint) | — | — |
| Gemini | `GEMINI.md` | — | — |
| Qwen | `QWEN.md` | — | optional `.qwen/settings.json` |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/agents/orchestrator.md` | — |
| Windsurf | `.windsurf/rules/rules.md` | `.windsurf/agents/orchestrator.md` | — |
| Junie | `.junie/guidelines.md` | `.junie/agents/orchestrator.md` | — |
| Antigravity | `.antigravity/rules.md` | `.antigravity/agents/orchestrator.md` | — |

`Codex`, `Cursor`, and historical `DeepSeek` intentionally share a root entrypoint.
DeepSeek client-context resolution requires an explicit concrete host; the
legacy instruction identity and aliases are retained.

Antigravity's `.antigravity` paths are historical Garda materialization, not
proof of the current native `agy` / `.agents` contract. Any mandatory review
requires a real current-session launch and authenticated receipts.

## Desktop Identity Declaration Coverage

The consumed client catalog matches exact Desktop revision `2026-09-29.1`:
16 named CLI declarations plus one generic declaration, separate from 19 model
APIs. [The independent catalog fixture](../tests/fixtures/providers/desktop-cli-catalog-2026-09-29.json)
preserves its source commit/hash and original labels, executables and managed
adapter restrictions. These declarations do not extend the materialization table
above or prove runtime permission.

| Declaration boundary | Deterministic contract | Native evidence |
| --- | --- | --- |
| Existing named Desktop clients | Desktop IDs/labels resolve to their retained client identities; Gemini and Windsurf legacy entries remain separate. | Existing versioned observations and remaining limits are listed in [client evidence](provider-client-evidence.md). |
| Grok, OpenCode, Kimi, CodeBuddy, IFlow, Auggie, Kiro, Goose, Cline | Explicit IDs resolve to distinct clients, with unknown version/loading/launch. Model and instruction aliases do not select them. | Nine executables absent from local PATH; loading and fresh-launch probes unverified. iFlow primary source announces service shutdown. |
| Generic CLI | Explicit name and rule paths required; no Codex fallback. Complete metadata snapshots are frozen and remain unverified. | No native generic configuration, path-loading or session probe. |
| DeepSeek host | Explicit named or completely declared generic host; missing/non-concrete hosts remain refused. | Host identity metadata never certifies a standalone DeepSeek client or real launch. |

ProviderMinimalism remains the current selected-provider materialization default;
legacy all-provider installs are a distinct retained scenario. The owning
`provider-entrypoint-minimalism` regression still covers those behaviors. Neither
this metadata catalog nor a shared AGENTS filename silently installs every client,
chooses a two-file layout or certifies profile/skill discovery.

## Core Structural Fixture Matrix

| Feature | Claude | Codex | Cursor | DeepSeek | Gemini | Qwen | GitHub Copilot | Windsurf | Junie | Antigravity |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Entrypoint materialization | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Managed-block injection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Redirect entrypoints | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Start-task router | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Orchestrator bridge profile | — | — | — | — | — | — | ✅ | ✅ | ✅ | ✅ |
| Skill bridge agents | — | — | — | — | — | — | ✅ | — | — | — |
| Token economy | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Scoped diffs | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Compact-command protocol | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Generated Gate Sequence Compliance

All supported providers share the same mandatory gate sequence.
Tests verify that each materialized entrypoint and start-task router includes the
ordered gate text; a fixture is not a native run through every client.

| Gate | Claude | Codex | Cursor | DeepSeek | Gemini | Qwen | GitHub Copilot | Windsurf | Junie | Antigravity |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `enter-task-mode` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `load-rule-pack` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `classify-change` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `compile-gate` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `build-review-context` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `required-reviews-check` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `doc-impact-gate` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `completion-gate` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Review Delegation

Required reviews run as independent fresh-context delegated sub-agents only on providers with a confirmed delegated launch surface.

| Provider | Current-session requirement | Native probe status in this evidence set |
|---|---|---|
| Claude | Actual declared tool and clean-context option; exact launch input and receipt | Unknown; client version/settings/loading/launch not probed |
| Codex | Actual declared tool; `fork_turns="none"` when `collaboration.spawn_agent` is exposed | Real owned session launches observed; desktop version unknown; local CLI loading/launch unprobed |
| Cursor | Actual fresh isolated delegation, not a registry policy tier | Unknown; no installed-client probe |
| DeepSeek | Explicit concrete host and that host's real session evidence | Refused without host; no standalone client claim |
| GitHub Copilot | Actual surface-specific delegated tool and isolation | Unknown; CLI/IDE/cloud evidence is not interchangeable |
| Windsurf | Actual current client tool and isolation | Unknown; documentation redirect does not rename stored identity |
| Junie | Actual current client tool and isolation | Unknown; no installed-client probe |
| Antigravity | Actual `agy` / other surface tool and isolation | Unknown; native docs and historical Garda paths differ |
| Gemini | Actual Gemini client tool and isolation | Unknown; version, access and session capability unprobed |
| Qwen | Fresh independent context, not an inherited-context fork | Unknown; native subagent docs are not launch evidence |

**Notes:**
- Required reviews must use `delegated_subagent` mode on every provider that supports mandatory independent review.
- Providers or bridges that cannot launch delegated reviewer sub-agents cannot satisfy the mandatory review workflow.
- `delegation_required` expresses policy, not session capability. Version metadata,
  model labels, files, environment markers and parsed fixtures cannot satisfy it.
- Unsupported or unavailable operations remain explicit refusals. Unknown native
  evidence remains unverified; no paid probe or automatic API fallback is implied.

## Review Type Support

Review lanes are available through the same gate infrastructure.
Whether a specific review type activates depends on the catalog, capability flag, profile state, trigger, and
preflight scope—not the provider. The task snapshot also freezes the validated dependency graph that orders launches.

| Review Type | Pass Token | Shared Garda lane contract |
|---|---|:---:|
| code | `REVIEW PASSED` | ✅ |
| db | `DB REVIEW PASSED` | ✅ |
| security | `SECURITY REVIEW PASSED` | ✅ |
| refactor | `REFACTOR REVIEW PASSED` | ✅ |
| api | `API REVIEW PASSED` | ✅ |
| test | `TEST REVIEW PASSED` | ✅ |
| performance | `PERFORMANCE REVIEW PASSED` | ✅ |
| infra | `INFRA REVIEW PASSED` | ✅ |
| dependency | `DEPENDENCY REVIEW PASSED` | ✅ |

The table lists compatibility-owned built-ins and their immutable verdict tokens. Optional custom lanes are declared in `review-catalog.json`, start disabled, and become provider-independent after their skill, capability, and profile state are enabled. Garda derives canonical `<REVIEW ID> REVIEW PASSED/FAILED` tokens from the stable lane ID; custom prompt bodies and verdict overrides are not supported. Legacy workspaces without the catalog retain the built-in table unchanged.

Normal provider bridges consume the compact task-start catalog summary, immutable preflight snapshot, and lane-specific generated launch input. They do not load the full repo catalog into every agent or reviewer context. Catalog/profile mutations use guarded preview-confirm-apply and affect only future task snapshots.

## Fixture Coverage by Registry Entry

The execution-path test suite (`tests/node/gates/shared/provider-workflow-execution.test.ts`) validates
registry entries across multiple dimensions in controlled fixtures. It does not
execute each vendor client or prove its native file-loading semantics.

| Test Dimension | Coverage Shape |
|---|---|
| Handshake diagnostics | Checked for each supported provider entry. |
| Evidence lifecycle | Checked for each supported provider entry. |
| Provider compliance | Checked for managed blocks, entrypoints, bridges, and expected provider-owned files. |
| Gate sequence verification | Checked for the mandatory ordered gate set. |
| Bridge execution contracts | Checked for providers with bridge profiles. |
| Cross-provider context | Checked for shared-entrypoint and multi-provider workspaces. |
| Redirect entrypoints | Checked for generated redirect files and canonical source-of-truth routing. |
| Structural invariants | Checked for registry and materialization consistency. |
| Compliance format output | Checked for machine-readable validator output. |

Additional provider-relevant test suites:

| Suite | Path | Scope |
|---|---|---|
| Cross-provider router matrix | `tests/node/materialization/cross-provider-router-matrix.test.ts` | Entrypoint canonicalization across supported provider entries and unique entrypoints |
| Provider compliance validators | `tests/node/validators/provider-compliance.test.ts` | Managed-block and structure validation |
| CLI provider routing | `tests/node/cli/commands/gates/shared/gates.test.ts` | `--provider` option dispatch |

## Status Definitions

| Badge | Meaning |
|---|---|
| ✅ Fixture coverage | The stated Garda structural contract has repository tests; native client readiness requires separate versioned probes. |
| 🟡 Partial | Core workflow exists, but some documented surfaces or non-critical capability details still need follow-up before the provider story is fully consistent. |
| 🔬 Experimental | Designed and materialized, but broader real-task evidence is still limited. |
| — | Feature does not apply to this provider (e.g., bridge profiles for root-entrypoint-only providers). |

## Evidence Sources

| Evidence | Location |
|---|---|
| Provider constants and entrypoint map | `src/core/constants.ts` |
| Bridge and skill-bridge profile definitions | `src/materialization/common.ts` |
| Reviewer routing and delegation policy | `src/gates/review/reviewer-routing.ts` |
| Delegation rules | `garda-agent-orchestrator/live/skills/orchestration/SKILL.md` |
| Dated native primary sources and probe limits | [Provider client evidence](provider-client-evidence.md) |
| Explicit client / host / negative-evidence contract | `src/core/provider/provider-client-context.ts`, `tests/node/core/provider-client-context.test.ts` |
| Execution-path tests (T-011) | `tests/node/gates/shared/provider-workflow-execution.test.ts` |
| Cross-provider router tests | `tests/node/materialization/cross-provider-router-matrix.test.ts` |
| Provider compliance tests | `tests/node/validators/provider-compliance.test.ts` |
| Review capabilities config | `garda-agent-orchestrator/live/config/review-capabilities.json` |
| Optional review catalog | `garda-agent-orchestrator/live/config/review-catalog.json` |
| Token economy config | `garda-agent-orchestrator/live/config/token-economy.json` |
