# Supported Providers

Garda supports multiple AI coding agent provider surfaces through one canonical workflow.
This page is the human-readable provider list for the current release line.

For test-backed details, see [Provider Compatibility Matrix](compatibility-matrix.md).

## Current Provider Surfaces

| Provider | Entrypoint | Bridge Profile | Notes |
|---|---|---|---|
| Claude | `CLAUDE.md` | — | Root provider entrypoint. |
| Codex | `AGENTS.md` | — | Shares the root `AGENTS.md` compatibility path. |
| Cursor | `AGENTS.md` | — | Shares the root `AGENTS.md` compatibility path. |
| DeepSeek | `AGENTS.md` | — | Shares the root `AGENTS.md` compatibility path. |
| Gemini | `GEMINI.md` | — | Root provider entrypoint. |
| Qwen | `QWEN.md` | optional `.qwen/settings.json` | Root provider entrypoint with optional config bootstrap. |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/agents/orchestrator.md` | Provider bridge profile for orchestrator routing. |
| Windsurf | `.windsurf/rules/rules.md` | `.windsurf/agents/orchestrator.md` | Provider bridge profile for orchestrator routing. |
| Junie | `.junie/guidelines.md` | `.junie/agents/orchestrator.md` | Provider bridge profile for orchestrator routing. |
| Antigravity | `.antigravity/rules.md` | `.antigravity/agents/orchestrator.md` | Antigravity 2.0 / Antigravity CLI provider surface with delegated sub-agent review support when the active runtime can launch fresh reviewer subagents. |

## Provider-Native Instruction and Skill Surfaces

The table below describes what Garda materializes today. “Shared skills” means the
provider reads the selected `garda-agent-orchestrator/live/skills/<skill-id>/SKILL.md`
through the canonical workflow or a bridge profile; Garda does not currently copy
those skills into provider-specific skill directories.

| Provider | Instructions or rules | Agent profiles | Skills and commands | Host metadata |
|---|---|---|---|---|
| Claude | Root instructions in `CLAUDE.md` | None generated | Shared skills and shared `.agents/workflows/start-task.md` router | Optional `.claude/settings.local.json` bootstrap |
| Codex | Root instructions in `AGENTS.md` | None generated | Shared skills and shared start-task router | Explicit runtime provider identity; no path-only inference |
| Cursor | Root instructions in shared `AGENTS.md` | None generated | Shared skills and shared start-task router | Explicit runtime provider identity distinguishes it from Codex and DeepSeek |
| DeepSeek | Root instructions in shared `AGENTS.md` | None generated | Shared skills and shared start-task router | Explicit runtime provider identity distinguishes it from Codex and Cursor |
| Gemini | Root instructions in `GEMINI.md` | None generated | Shared skills and shared start-task router | Provider identity and aliases come from the registry |
| Qwen | Root instructions in `QWEN.md` | None generated | Shared skills and shared start-task router | Optional `.qwen/settings.json` bootstrap |
| GitHub Copilot | Repository instructions in `.github/copilot-instructions.md` | `.github/agents/orchestrator.md` plus reviewer profiles under `.github/agents/*.md` | Agent profiles point to shared skills; shared start-task router supplies commands | Review requirement and capability flag are embedded in each reviewer profile |
| Windsurf | Rules in `.windsurf/rules/rules.md` | `.windsurf/agents/orchestrator.md` | Bridge points to shared skills and the shared start-task router | Standard bridge profile metadata |
| Junie | Guidelines in `.junie/guidelines.md` | `.junie/agents/orchestrator.md` | Bridge points to shared skills and the shared start-task router | Standard bridge profile metadata |
| Antigravity | Rules in `.antigravity/rules.md` | `.antigravity/agents/orchestrator.md` | Compact bridge points to shared skills and the shared start-task router | `compact_router` profile with required bridge-path self-reference |

Garda emits no provider-specific slash-command files. The shared
`.agents/workflows/start-task.md` file routes task execution, while the Node CLI
prints the concrete gate commands for the active provider.

Provider identity, aliases, entrypoint paths, bridge paths, profile variants,
reviewer capability tier, environment markers, and managed-directory metadata are
owned by `src/core/provider/provider-registry.ts`. Skill metadata lives beside each
skill in `skill.json`; installed-skill discovery uses
`garda-agent-orchestrator/live/config/skills-index.json`, and review availability is
controlled by `garda-agent-orchestrator/live/config/review-capabilities.json` plus
the immutable current-task review snapshot. Future provider-specific skill copies
are deliberately outside this contract.

## Shared Entrypoints

Codex, Cursor, and DeepSeek intentionally share `AGENTS.md` while remaining separate runtime providers.
The shared file keeps the root workflow consistent and lets the runtime provider be tracked separately.

## Antigravity Review Delegation

Garda supports Antigravity 2.0 and Antigravity CLI provider surfaces for mandatory independent reviews when the active Antigravity runtime can delegate work to fresh sub-agent reviewers.
The fail-closed evidence model is unchanged: task-mode and handshake evidence must still attest a launchable delegated reviewer route, and review receipts must still record `reviewer_execution_mode=delegated_subagent` plus the provider-assigned reviewer identity.
If an Antigravity runtime cannot launch a fresh isolated reviewer for the current task context, Garda must stop or route to another supported provider instead of accepting hand-written review artifacts.

References: [Antigravity 2.0](https://antigravity.google/product/antigravity-2), [Antigravity CLI](https://antigravity.google/product/antigravity-cli), and [Antigravity CLI subagents](https://antigravity.google/docs/cli-subagents).
