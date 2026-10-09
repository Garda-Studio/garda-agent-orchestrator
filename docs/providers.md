# Supported Providers

Garda maintains multiple provider identities and materialization paths through one
canonical workflow. Emitting those files does not prove that a particular installed
client loads them or can launch independent reviewers.

For structural fixture coverage, see [Provider Compatibility Matrix](compatibility-matrix.md).
For dated native documentation, version limits and explicit refusal states, see
[Provider client evidence](provider-client-evidence.md).

## Current Garda Materialization Paths

| Provider | Entrypoint | Bridge Profile | Notes |
|---|---|---|---|
| Claude | `CLAUDE.md` | — | Root provider entrypoint. |
| Codex | `AGENTS.md` | — | Shares the root `AGENTS.md` compatibility path. |
| Cursor | `AGENTS.md` | — | Shares the root `AGENTS.md` compatibility path. |
| DeepSeek | `AGENTS.md` | — | Historical model-provider identity; client-context resolution requires an explicit concrete host. |
| Gemini | `GEMINI.md` | — | Root provider entrypoint. |
| Qwen | `QWEN.md` | optional `.qwen/settings.json` | Root provider entrypoint with optional config bootstrap. |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/agents/orchestrator.md` | Provider bridge profile for orchestrator routing. |
| Windsurf | `.windsurf/rules/rules.md` | `.windsurf/agents/orchestrator.md` | Provider bridge profile for orchestrator routing. |
| Junie | `.junie/guidelines.md` | `.junie/agents/orchestrator.md` | Provider bridge profile for orchestrator routing. |
| Antigravity | `.antigravity/rules.md` | `.antigravity/agents/orchestrator.md` | Historical materialization paths; current `agy` / `.agents` documentation is a separate native contract. |

## Garda Instruction and Skill Surfaces

The table below describes what Garda materializes today. “Shared skills” means the
provider reads the selected `garda-agent-orchestrator/live/skills/<skill-id>/SKILL.md`
through the canonical workflow or a bridge profile; Garda does not currently copy
those skills into provider-specific skill directories.

| Provider | Instructions or rules | Agent profiles | Skills and commands | Host metadata |
|---|---|---|---|---|
| Claude | Root instructions in `CLAUDE.md` | None generated | Shared skills and shared `.agents/workflows/start-task.md` router | Optional `.claude/settings.local.json` bootstrap |
| Codex | Root instructions in `AGENTS.md` | None generated | Shared skills and shared start-task router | Explicit runtime provider identity; no path-only inference |
| Cursor | Root instructions in shared `AGENTS.md` | None generated | Shared skills and shared start-task router | Explicit runtime provider identity distinguishes it from Codex and DeepSeek |
| DeepSeek | Root instructions in shared `AGENTS.md` | None generated | Shared skills and shared start-task router | Historical provider and instruction identity remain separate from an explicitly selected host client |
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
The existing instruction-file aliases remain compatible; the new client-context
API deliberately excludes them when resolving an explicit client identity.

## Client Context and Evidence

`resolveProviderClientContext` separates the requested registry identity, concrete
client, CLI/IDE/desktop/cloud surface, reported version, model/API selection and
`SourceOfTruth` / `ActiveAgentFiles` metadata. It is a pure metadata API, not a
replacement for task-mode, handshake or authenticated reviewer receipts.

An identified client with unknown evidence remains `unverified`. Missing or
unknown identity, an absent/conflicting host, or reported unsupported/unavailable
loading or launch produces `refused`. Positive labels such as `PASS` are invalid
metadata and cannot create native evidence. Existing gate callers, config schema,
provider policy tiers and emitted paths are unchanged.

## Desktop Client Identity Catalog

The public `getProviderClientCatalog()` metadata API lists the exact Desktop
revision `2026-09-29.1`: 16 named CLI identities plus `generic-cli`. Desktop's 19
model API providers are a separate catalog; their availability and credentials are
not inferred from these declarations.

| Desktop IDs | Resolved client IDs |
| --- | --- |
| `codex-cli`, `claude-cli`, `qwen-cli`, `antigravity-cli` | `Codex`, `Claude`, `Qwen`, `Antigravity` |
| `copilot-cli`, `cursor-cli`, `junie-cli` | `GitHubCopilot`, `Cursor`, `Junie` |
| `grok-cli`, `opencode-cli`, `kimi-cli`, `codebuddy-cli`, `iflow-cli` | `Grok`, `OpenCode`, `Kimi`, `CodeBuddy`, `IFlow` |
| `auggie-cli`, `kiro-cli`, `goose-cli`, `cline-cli` | `Auggie`, `Kiro`, `Goose`, `Cline` |
| `generic-cli` | `generic-cli`, only with an explicit client name and nonempty rule-path array |

The existing ten instruction-provider entries and setup choices remain compatible;
Gemini, Windsurf and historical DeepSeek are not renamed or inferred from Desktop
API entries. This catalog extends metadata identity resolution, not native task
admission, setup/schema options or profile emission. Unknown evidence stays
`unverified`, including clients whose executable name is declared in the catalog.

Generic callers provide `genericClientName` and `genericRulePaths` explicitly;
neither AGENTS presence nor `SourceOfTruth=Codex` supplies them. A complete result
retains `clientId: generic-cli` and a frozen generic declaration, with model and
instruction selection independent. Missing generic fields yield explicit refusal
codes. See the [API and dated additional-client matrix](provider-client-evidence.md)
for validation limits and unavailable probes. iFlow's documented service shutdown
is retained as an availability limit, not hidden by its historical catalog row.

## Antigravity Review Delegation

Antigravity mandatory independent review requires the active runtime to delegate
work to fresh isolated reviewers; generated bridge text is not proof of that capability.
The fail-closed evidence model is unchanged: task-mode and handshake evidence must still attest a launchable delegated reviewer route, and review receipts must still record `reviewer_execution_mode=delegated_subagent` plus the provider-assigned reviewer identity.
If the runtime cannot launch a fresh isolated reviewer for the current task
context, report the blocker. This contract does not authorize an automatic
provider/model/API fallback or hand-written review artifacts.

References: [current Antigravity rules](https://www.antigravity.google/docs/rules/),
[CLI tutorial](https://www.antigravity.google/docs/cli/tutorial), and
[custom agents](https://www.antigravity.google/docs/cli/commands/agents/).
