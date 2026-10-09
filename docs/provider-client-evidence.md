# Provider client evidence

## Codex independent-review launch guidance

Use the tools and input schema declared by the current Codex client. A provider
label, model name, environment marker, or instruction-file name does not prove
that the current session can launch an independent reviewer.

The Codex session used for this observation exposes `collaboration.spawn_agent`.
Its clean-context input is `fork_turns="none"`. This is an observed interface,
not a requirement that every Codex CLI, IDE, desktop, or cloud surface must expose
that namespace. Another surface must use its own declared launch tool and
isolation parameter; `fork_context=false` applies only where the actual schema
supports it. If fresh isolated delegation is unavailable, report the blocker.
Do not substitute self-review or an automatic model/API fallback.

Prepare the native reviewer launch input before creating the fresh reviewer.
Pass the exact `CopyPasteReviewerLaunchPrompt` or reviewer-facing
`ReviewerLaunchInputArtifactPath`; `ReviewerLaunchArtifactPath` is controller
metadata. Preserve the real provider invocation identity, immediately record
native delegation start with the exact launch-input evidence, and finalize the
launch after the actual reviewer returns. Persist the validated receipt before
closing or releasing the reviewer. Model and reasoning selection remain separate
from provider identity and follow the task's authorized review requirements.

## Observation boundaries

| Item | Evidence and limit |
| --- | --- |
| Observation date | 2026-10-09 UTC |
| Source examined | `9cd2020178a2ef7e0e56854830c76d5ab73500cb`, before this instruction correction |
| Declared session tool | `collaboration.spawn_agent` with `fork_turns="none"`, from the actual session tool schema |
| Real launch evidence | The preceding owned T-079 code/test reviews used fresh isolated launches, real invocation identities, validated native receipts and post-commit acceptance; owner-local artifacts remain separate from source |
| Garda runtime | 1.4.4; this is the orchestrator version, not a Codex client version |
| Local execution platform | Linux, Node.js 24.19.0 |
| Codex desktop/app version | Unknown; no versioned desktop probe is claimed |
| Other Codex surfaces | Not probed by this correction; CLI documentation, generated text and another session's capabilities are distinct evidence |
| Other provider loading, catalog and profiles | Outside this bounded correction; unchanged provider identities and policy tiers remain compatibility contracts |

`src/core/provider/provider-registry.ts` owns provider launch metadata.
`src/gate-runtime/review/reviewer-session-contract.ts` supplies shared instruction
text consumed by task-router and standard/compact bridge generation. Registry and
materialization regressions check current-client conditional isolation, reject
the obsolete universal Codex namespace, and retain exact-input, refusal and
reviewer cleanup boundaries. These generated-text tests establish the guidance
contract; they do not certify native loading or launch capability for an
unprobed client.

## Explicit client context API

`resolveProviderClientContext` is exported from `src/core/provider-registry.ts`.
It accepts a plain metadata object; optional fields may be omitted or null.
Tokens are trimmed strings of at most 1024 characters, without control characters.
Surface and negative-evidence choices are case-insensitive. Unknown extra fields
are ignored and cannot select a client or attest capabilities.

```typescript
resolveProviderClientContext({
    clientIdentity: 'DeepSeek', hostClientIdentity: 'Codex', surface: 'cloud',
    reportedVersion: null, modelProvider: 'DeepSeek', modelId: 'deepseek-chat',
    sourceOfTruth: 'DeepSeek', activeAgentFiles: 'AGENTS.md',
    nativeLoading: 'unknown', reviewerLaunch: 'unknown'
});
// requestedProviderId: DeepSeek; clientId: Codex; status: unverified
```

| Dimension | Contract |
| --- | --- |
| Explicit identity | A legacy canonical/display/launch label or explicit Desktop catalog ID, client ID or display label, case-insensitive. Instruction aliases such as `AGENTS.md`, model aliases, environment markers and `SourceOfTruth` never identify the client. |
| Concrete host | Historical DeepSeek requires an explicit concrete host declaration. Named Desktop clients are recognized; a generic host also needs its explicit name and rule paths. Missing, unknown or non-concrete hosts are refused. A different host for an already-concrete client is a conflict. |
| Surface / version | `cli`, `ide`, `desktop`, `cloud` or `unknown`; `reportedVersion` is caller metadata, not a version or capability probe. |
| Model / instructions | `modelProvider` / `modelId` and `sourceOfTruth` / `activeAgentFiles` are retained as separate strings. No identity migration, file loading or config write occurs. |
| Evidence | Only `unknown`, `unsupported`, `unavailable` are accepted. `PASS`, `available`, `supported`, `ready`, booleans and other positive assertions are invalid input. |
| Outcome | `unverified` never authorizes a gate or native action. `refused` carries ordered identity/host/generic-configuration/loading/launch refusal codes. Unsupported/unavailable evidence does not erase an otherwise-resolved client identity. |
| Boundary errors | `ProviderClientContextInputError` identifies the invalid field and expected form without echoing its value. Malformed shapes, types, control characters, excessive tokens or choices throw it. |

The returned context and its nested values are immutable snapshots. This API does
not read files/environment, probe clients, launch reviewers or produce receipts.
Existing native admission and authentication callers are unchanged; positive
readiness remains their responsibility. The optional registry host marker is
additive; historical IDs, aliases, policy tiers, materialization paths,
`SourceOfTruth` and `ActiveAgentFiles` contracts remain intact.

### Desktop catalog and explicit generic declaration

`getProviderClientCatalog()` returns immutable identity declarations projected from
Garda AI Desktop's exact `config/model-providers.json`, commit
`245d71f5b16b899912b5be21a1aa9309a38425ed`, schema 2, revision `2026-09-29.1`,
SHA256 `3ddba0a985bb58d2c8ec7f755c4b381dde49e3971b95aebe572ca5e92a7c1bac`.
The earlier revision `2026-09-28.1` is separate provenance, not that file's hash.
There are **16 named CLI declarations, one generic CLI declaration and 19 separate
model API declarations**. API IDs do not become client identities. The independent
fixture retains the original CLI labels/executables and declared Desktop managed
execution restrictions for Auggie, Cursor and Junie; those restrictions describe
Desktop adapters, not this session's permissions or launch capability.

`generic-cli` requires a trimmed `genericClientName` and at least one explicit
`genericRulePaths` entry. Missing values return `GENERIC_CLIENT_NAME_REQUIRED` and/or
`GENERIC_RULE_PATHS_REQUIRED`, with no resolved concrete client. Rule paths must be
an array of at most 32 nonempty token strings; tokens use the same 1024-character
and control-character boundary. Exact trimmed duplicates are removed in order.
These strings are declarations: this API does not resolve paths, read files,
expand imports, check filesystem permissions or execute them. Native consumers
must apply their actual client, version and filesystem guards.

```typescript
resolveProviderClientContext({
    clientIdentity: 'generic-cli', genericClientName: 'MyTool',
    genericRulePaths: ['rules/project.md', 'nested/agent.md'],
    surface: 'cli', sourceOfTruth: 'Qwen', activeAgentFiles: 'QWEN.md',
    modelProvider: 'openai', modelId: 'chosen-model'
});
// clientId: generic-cli; genericClient: { name: MyTool, rulePaths: [...] }
// status: unverified; nativeLoading and reviewerLaunch: unknown
```

The returned `genericClient` and copied rule-path array are frozen. The field is
present only for a complete, resolved generic declaration, including a generic
DeepSeek host. A name such as `Codex` still leaves its identity `generic-cli`;
rules and `SourceOfTruth` never silently select Codex. Generic fields are ignored
for other clients, preserving the existing non-generic response shape. This
metadata API does not add a generic setup option, register new native gate callers
or emit client profiles; use actual CLI help for supported setup values.

## Dated native contract matrix

Primary documentation read on **2026-10-09 UTC**. These are documentation facts,
not installed-client probes or a certification of the reported minimum versions.
Includes mean native expansion, not prose asking an agent to read another file.
Exact settings, trust roots, version and surface must accompany a real probe.

| Existing client family | Documented entrypoints, precedence and nested scope | Includes / settings / version boundary | Primary source |
| --- | --- | --- | --- |
| Codex | Start-time global and root-to-current-directory instruction chain. One override/default/configured fallback file per directory; byte limit applies. | Native `AGENTS.override.md` before `AGENTS.md`; fallback names are configuration. A prose redirect does not establish automatic inclusion. | [Instruction guide](https://developers.openai.com/codex/guides/agents-md), redirected to [current guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md) |
| Claude Code | Native AGENTS availability is version/settings dependent. In default `claude-md-or-agents-md`, project/ancestor `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` suppresses AGENTS; global/managed/rules files do not have that effect. | AGENTS support documented from 2.1.277, with pre-2.1.281 Bedrock/telemetry caveats and plugin-ID transition at 2.1.285. `claude-md-and-agents-md`, `claude-md` and `managed-only` differ. Native `@AGENTS.md` import is distinct from prose; external imports may need approval. No native `AGENTS.local.md` / override claim. | [Memory and instruction loading](https://code.claude.com/docs/en/memory) |
| Cursor | Current rules docs describe root/nested AGENTS, more-specific precedence and `.cursor/rules/*.mdc`. CLI separately documents root AGENTS and CLAUDE alongside rules. | File mentions request tool reads, not automatic inlining. Rule metadata and native client/surface determine inclusion; older “nested support planned” descriptions are not current evidence. | [Rules](https://cursor.com/docs/rules), [CLI](https://prod.cursor.com/docs/cli/using) |
| Qwen Code | Current memory guide explicitly describes existing repository AGENTS alongside QWEN. Global, shared project and local `.qwen/QWEN.local.md` are described; local follows shared. | `context.fileName` is configurable; `@path` resolves relative to the instruction file. Memory dialog shows loaded context. Exact AGENTS precedence, nested behavior and installed-version settings remain unprobed. | [Memory](https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/), [settings](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/) |
| Gemini CLI | Global and workspace/ancestor GEMINI plus trusted-root just-in-time nested loading are documented. Gemini identity is independent of Antigravity. | Native `@file` imports, `/memory show` / reload and `context.fileName` choosing one or several names. Version, authentication/access and session capability remain unprobed. | [GEMINI context](https://geminicli.com/docs/cli/gemini-md/) |
| GitHub Copilot | CLI combines applicable user/repository, nested AGENTS and matching modular instructions; disabled-file controls exist. General precedence cannot be assumed; IDE/cloud/review support differs. | Relative `@` includes expand only in named instruction formats, within allowed roots. Absolute/home paths and arbitrary modular/GEMINI includes are not equivalent. | [CLI instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions), [surface support](https://docs.github.com/en/copilot/reference/custom-instructions-support) |
| Windsurf / Cascade | Original Windsurf docs redirect to Devin Desktop/Cascade docs: root AGENTS always-on, nested files directory-scoped, current `.devin/rules` preferred with `.windsurf/rules` fallback. | Rules have activation metadata. Redirect/naming observations do not migrate stored Windsurf IDs or certify installed-client compatibility. Native include/launch behavior remains unprobed. | [Original AGENTS URL](https://docs.windsurf.com/windsurf/cascade/agents-md) → [current docs](https://docs.devin.ai/desktop/cascade/agents-md); [rules/memory](https://docs.devin.ai/desktop/cascade/memories) |
| Junie | CLI guide dated 2026-10-08 prioritizes `.junie/AGENTS.md` exclusively, then root AGENTS plus playbook/rules, then legacy guidelines. Global/project context combines with project precedence and identical-content deduplication. | IDE custom-path selection has its own priority. Nested includes, client version and session launch are not established by these docs reads. Historical `.junie/guidelines.md` remains a Garda compatibility path. | [Guidelines/memory](https://junie.jetbrains.com/docs/guidelines-and-memory.html), [IDE plugin](https://junie.jetbrains.com/docs/junie-ide-plugin.html) |
| Antigravity | Current CLI is `agy`. Root/nested AGENTS or GEMINI and `.agents/rules` are documented. Immediate rules need valid trigger metadata; nested rules need explicit registration. | `@[label](path)` expansion differs from simple `@file` references. Historical Garda `.antigravity` paths are candidates requiring native verification, not silently renamed paths. | [Rules](https://www.antigravity.google/docs/rules/), [CLI tutorial](https://www.antigravity.google/docs/cli/tutorial) |

### Native agents, skills and profile boundaries

No provider-specific agent/profile/skill files are emitted by this API. Existing
Garda bridges consume shared skills; their filenames do not prove native discovery.
The following documented examples are distinct from versioned loading/launch probes.

| Family | Dated documented agent/profile facts | Skills / fresh independent review evidence |
| --- | --- | --- |
| Codex | This session declares `collaboration.spawn_agent` with `fork_turns="none"`; a tool schema is not an on-disk profile schema. | Actual owned launches/receipts are session-local. Other client profile/skill loading is unprobed. |
| Claude | Memory/plugin settings govern AGENTS loading; generated Garda launch text is not proof of installed tool/profile support. | Native profile/skill discovery and installed fresh-reviewer launch unprobed. |
| Cursor | [Subagents](https://cursor.com/docs/subagents) documents `.cursor/agents` Markdown/frontmatter and location precedence over `.claude` / `.codex`. | Schema documentation is not native file-loading or isolated-launch evidence. Skill discovery unprobed. |
| Qwen | [Subagents](https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents/) describes `.qwen/agents`, regular independent versus inherited fork context, and Claude frontmatter compatibility. | External executors need their own installation/authentication; no automatic model/API fallback. Skills and actual fresh launch unprobed. |
| Gemini | GEMINI context documentation does not prove custom agent/profile schema or reviewer capability. | Native agent/skill loading and fresh launch unprobed. |
| GitHub Copilot | [Custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents) uses `.github/agents` with user/repository/organization/enterprise location precedence. | Surface-specific profiles and actual tools still need native probes; shared Garda skills are not native skill discovery. |
| Windsurf | Current rule trigger metadata is distinct from historical Garda `.windsurf/agents` bridge names. | Native agent/profile/skill discovery and isolated launch unprobed. |
| Junie | Current guideline selection is distinct from Garda `.junie/agents` bridge filenames. | Native profile/skill schema and isolated launch unprobed. |
| Antigravity | [Custom agents](https://www.antigravity.google/docs/cli/commands/agents/) describes `.agents/agents/<name>/agent.md` with YAML `name` / `description`; global location is separate. | Parsed frontmatter is a fixture, not actual profile/skill loading or reviewer launch. |

### Actual versioned probes and refusal boundaries

| Probe | Actual observation | What remains unknown |
| --- | --- | --- |
| Local Codex CLI | `codex --version`, executable `/opt/codex/bin/codex`, exit 0: `0.159.0-alpha.3`, observed 2026-10-09 UTC on Linux / Node 24.19.0. Startup PATH-alias warning was retained locally. | No conversation, authentication, instruction-loading or delegation probe. This executable's version is not the existing desktop/app version. |
| Existing Codex session | Actual tool declaration and prior owned T-079 / T-129-1 fresh independent launches with native receipts. App/desktop version unknown. | No general compatibility claim for all Codex surfaces or on-disk profile loading. No foreign receipt import. |
| Other eight client families | Dated primary documentation only; no installed-client probe performed. | Version, enabled settings, access, native loading, profile/skill discovery and session launch remain unknown. |
| DeepSeek host selection | Deterministic resolver tests require an explicit concrete known host and preserve the historical provider identity. | No standalone DeepSeek-client loading or launch claim; reported unsupported/unavailable host operations are refused. |

Fixture assertions, parsed documents and reported versions never become native
`PASS`. These unknowns require future versioned probes on available platforms;
Windows/macOS and hosted CI are not part of this local evidence. Native profile
emission (T-132), skill/discovery work (T-131/T-133), migration (T-187) and remaining
native adapter/config integration are separate scopes. No paid conversation, dummy
review, automatic fallback or changed user model/access setting is authorized here.

## Additional Desktop client contracts

Primary-source documentation was rechecked on **2026-10-09 UTC**. Local Linux
command discovery found `grok`, `opencode`, `kimi`, `codebuddy`, `iflow`, `auggie`,
`kiro-cli`, `goose` and `cline` absent from PATH. Discovery is not an attempted
native loading or reviewer launch: installed versions, enabled settings, profiles,
skills, authentication and session launch remain **unverified** for these clients.
The canonical identities below are metadata declarations, not maintained-support
badges. Keep the documented version/surface distinctions when a probe becomes
available; prefer shared AGENTS only after that client's actual loading is verified.

| Desktop ID / client ID | Dated primary contract and limits | Primary source |
| --- | --- | --- |
| `grok-cli` / `Grok` | The catalog names vendor Grok Build, not a community Grok wrapper. Vendor docs describe hierarchical AGENTS and Claude compatibility plus independent agent contexts. Includes, precedence settings and actual launch tools remain unprobed. | [Grok Build](https://x.ai/build), [skills/plugins/marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces) |
| `opencode-cli` / `OpenCode` | Current V2 instructions use AGENTS only, without CLAUDE fallback; nearest-first upward combination and lazy nested loading are documented. The V2 `instructions` array does not yet resolve files, globs or URLs. Older V1 import guidance must not be substituted for V2 behavior. | [V2 instructions](https://opencode.ai/v2/docs/instructions) |
| `kimi-cli` / `Kimi` | Current Kimi Code docs describe explicit/project/extra/user/plugin/builtin agent precedence, Markdown/frontmatter, `.kimi-code/agents` and `.agents/agents`, plus KIMI_CODE_HOME and `~/.agents` instruction locations. Older kimi-cli naming is version-specific; actual schema/loading is unprobed. | [Kimi Code agents](https://moonshotai.github.io/kimi-code/en/customization/agents) |
| `codebuddy-cli` / `CodeBuddy` | Project CODEBUDDY precedes AGENTS fallback; native `@` includes, ancestor and dynamic nested rules are documented. CLI and IDE conditional-rule behavior differ. This is not proof of either installed surface. | [CLI memory](https://www.codebuddy.ai/docs/cli/memory) |
| `iflow-cli` / `IFlow` | The primary repository announces service shutdown on **2026-04-17 UTC+8**. Historical documentation, a catalog row or retained executable cannot establish maintained service support. No alternative API or model fallback is performed. | [Primary iFlow repository](https://github.com/iflow-ai/iflow-cli) |
| `auggie-cli` / `Auggie` | CLI rules document explicit `--rules`, CLAUDE/AGENTS and workspace/user rule sources with hierarchical loading; manual rules are skipped by CLI and user rules always apply. Desktop separately requires a dedicated managed-execution adapter. | [CLI rules](https://docs.augmentcode.com/cli/rules) |
| `kiro-cli` / `Kiro` | Steering/AGENTS resources and custom JSON/Markdown agents are documented. General steering guidance and current custom-agent default resource inheritance differ by surface/version; verify the actual version before emitting configuration. | [Steering](https://kiro.dev/docs/steering/), [custom agents](https://kiro.dev/docs/cli/custom-agents/), [configuration](https://kiro.dev/docs/cli/custom-agents/configuration-reference/) |
| `goose-cli` / `Goose` | Developer extension context defaults to AGENTS and `.goosehints`; hierarchy/lazy nesting, immediate `@` includes and local/global sources are documented. Extension enablement and recipe/profile behavior need separate actual probes. | [Context instructions](https://goose-docs.ai/docs/guides/context-engineering/using-goosehints/) |
| `cline-cli` / `Cline` | `.clinerules` / `.cline/rules`, root and `~/.agents/AGENTS.md` instructions and workspace/global precedence are documented. CLI, IDE and desktop paths differ; nested/includes and actual isolated-launch interfaces remain unprobed. | [Cline rules](https://docs.cline.bot/customization/cline-rules) |

The model engine remains independent of these identities. Declared executable names
and catalog capability flags never attest loading, access or a fresh reviewer.
Grok versus xAI, Kimi versus a Moonshot model and historical DeepSeek versus its
concrete host remain separate choices. Gemini is retained separately from
Antigravity; Windsurf history is not renamed to Devin. Native profile emission,
discovery, migration and runtime adapter ownership remain in their assigned tasks.
