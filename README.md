# Garda Agent Orchestrator

<p align="center">
  <img src="docs/assets/garda-github-social-preview.png" alt="Garda - Governed workflows for AI coding agents" />
</p>

**Governed workflows for AI coding agents.**

Garda supports multiple AI coding agent provider surfaces through one canonical workflow. See [Supported Providers](docs/providers.md) for the current provider list, entrypoints, bridge profiles, and known provider-specific limitations.

`GARDA = Governed Agent Runtime, Deployment, and Audit.`

**[Website](https://garda-workflow.netlify.app/)** · **[Quick Start](#quick-start)** · **[User Guide](HOW_TO.md)** · **[Providers](docs/providers.md)** · **[Architecture](docs/architecture.md)** · **[Work Example](docs/work-example.md)** · **[CLI Reference](docs/cli-reference.md)** · **[Configuration](docs/configuration.md)** · **[Changelog](CHANGELOG.md)**

## Without Garda / With Garda

| Without Garda | With Garda |
|---|---|
| Agent jumps straight into edits | Agent enters a controlled task workflow |
| Tests, reviews, and docs checks depend on discipline | Gates run in a defined order |
| Completion means whatever the agent claims | Completion is checked before being accepted |
| Review context can drift | Review artifacts are required |
| No shared audit trail | Task-event history records the workflow |
| Each provider needs separate habits | One workflow surface across agents |

## Workflow

```text
Task -> enter-task-mode -> load-rule-pack -> preflight -> compile -> review-context -> required reviews -> doc-impact -> completion
```

Garda does not replace your coding agent. It gives every agent the same controlled path to done.

## Why Garda?

AI coding agents are powerful, but in real repositories they can skip steps, lose context, avoid reviews, and mark work as done too early.

Garda adds a governance layer:

- task lifecycle: `TODO → IN_PROGRESS → IN_REVIEW → DONE`
- mandatory gates: preflight, compile, review, doc-impact, completion
- provider-agnostic rules with documented provider entrypoints and bridge profiles
- auditable task events and review artifacts
- local Node/TypeScript CLI runtime
- token-economy defaults for compact green-path execution

## Quick Start

```shell
npm install -g garda-agent-orchestrator
garda setup
```

Then give [AGENT_INIT_PROMPT.md](AGENT_INIT_PROMPT.md) to your coding agent. The agent reuses existing init answers, confirms active agent files, initializes or refreshes project memory from repository evidence, offers optional skill packs, and finishes with `garda agent-init`.

After `garda agent-init` passes, pick a task from `TASK.md` and tell the agent:

```text
Execute task T-001 from TASK.md strictly through the orchestrator. Use `next-step` as the navigator before the first gate, after each suggested command, and after failures.
```

The active profile (`balanced`, `fast`, `strict`, `docs-only`) and the `TASK.md` `Profile` column provide the default execution mode. Let `next-step` print the current mandatory command instead of hardcoding gate order in the prompt.

Temporary fallback without global install:

```shell
npx -y garda-agent-orchestrator setup
```

`npx` runs the package once and does not keep `garda` or `gao` in your `PATH`.
If you want persistent commands, install globally.

## Key Features

| Feature | Description |
|---|---|
| **Many Provider Surfaces** | One canonical workflow with provider-specific entrypoints and bridges; see [Supported Providers](docs/providers.md) for the current list |
| **Mandatory Quality Gates** | Preflight → Compile → Review → Doc-Impact → Completion |
| **Token Economy** | Reviewer-context compaction, scoped diffs, gate output filtering — saves 60–100% on green builds |
| **Task Lifecycle** | `TODO → IN_PROGRESS → IN_REVIEW → DONE` with hash-chain integrity |
| **Specialist Review Lanes** | code, db, security, refactor, api, test, performance, infra, and dependency reviews when the task scope requires them |
| **Extensible Review Catalog** | Guarded custom review lanes, profile states, dependency graphs, immutable task snapshots, and legacy-compatible defaults |
| **Node Runtime** | Public CLI and gate flows run through the Node/TypeScript router with no shell runtime dependency |
| **Compact Command Hints** | Agent rules teach efficient CLI flags for everyday commands |

## Supported Providers

The provider list is maintained in [docs/providers.md](docs/providers.md). That page documents current entrypoints, bridge profiles, shared `AGENTS.md` providers, and Antigravity 2.0 / CLI delegated-review support notes.

## CLI Commands

| Command | Description |
|---|---|
| `garda` | Safe overview: help + current project status |
| `garda setup` | First-run CLI onboarding without requiring an agent for the 6 answers |
| `garda agent-init` | Hard code-level gate that finalizes agent onboarding |
| `garda next-step` | Show the exact next orchestrator command for a task |
| `garda status` | Short project status snapshot |
| `garda doctor` | Run verify + manifest validation from existing answers |
| `garda preprompt` | Build a read-only task brief with current context and canonical next commands |
| `garda html` | Write a static read-only HTML report with optional snapshots |
| `garda ui` | Start a read-only localhost UI with lazy task details |
| `garda ui --actions` | Start the localhost UI with guarded allow-listed actions that require confirmation |
| `garda status why-blocked` | Explain why blocked or stalled tasks cannot progress, including task-event lock blockers |
| `garda doctor explain` | Print remediation steps for known failure IDs |
| `garda bootstrap` | Bundle-only deploy without install |
| `garda install` | Deploy/refresh orchestrator (requires init-answers.json) |
| `garda init` | Re-materialize `live/` from existing answers |
| `garda reinit` | Change init answers without full reinstall |
| `garda check-update` | Compare current deployment with a newer npm package or local source |
| `garda update` | Apply the update workflow directly (`--dry-run` for preview) |
| `garda update git` | Apply or preview an update from a git repo or local clone |
| `garda rollback` | Roll back to a specific version or restore from the latest rollback snapshot |
| `garda cleanup` | Preview/apply tiered runtime retention and inspect review-artifact policy |
| `garda repair` | Inspect or rebuild runtime indexes, protected manifests, and stale lock state |
| `garda uninstall` | Remove orchestrator while preserving `TASK.md` by default; queue removal requires explicit `--keep-task-file no` |
| `garda skills` | List, suggest, add, remove, and validate optional built-in skill packs |
| `garda profile` | List, switch, create, delete, and validate workspace profiles |
| `garda review-catalog` | Inspect, validate, explain, and safely manage built-in/custom review lanes |

Published command names: `garda`, `gao`, `garda-agent-orchestrator`

Full reference: **[docs/cli-reference.md](docs/cli-reference.md)**

## Version

- Package: `garda-agent-orchestrator`
- Current version source of truth: `VERSION`
- Package manifest versions: `package.json`, `package-lock.json`
- Recommended CLI install: `npm install -g garda-agent-orchestrator`
- Recommended first command: `garda setup`
- One-off fallback without install: `npx -y garda-agent-orchestrator setup`
- Install locally only if you want repo-local binaries in `node_modules/.bin`: `npm install garda-agent-orchestrator`

## Naming

- Package and bundle name: `garda-agent-orchestrator`
- Published command names: `garda`, `gao`, `garda-agent-orchestrator`
- Launcher path: `bin/garda.js`

## Runtime Baseline

- **Node.js 24 LTS is the primary runtime baseline** for the public CLI, lifecycle commands, and gate commands. Node.js 22.13+ is also supported as the compatibility runtime line.
- **A local Git working tree is required.** Garda uses `git status` and `git diff` from the local repository to derive task scope, dirty-worktree baselines, zero-diff evidence, protected control-plane drift, and review freshness. The hosting service does not matter: GitHub, GitLab, Bitbucket, a private server, or no remote at all are all acceptable as long as the project is a local Git repository and the `git` CLI is available.
- **1.4.x compatibility stance:** Node 22.13+ is covered by `package.json` engines, CI matrix coverage, release validation, runtime diagnostics, and documentation. Node 24 remains the primary line.
- **Compatibility note:** Node 23, Node 22 versions before 22.13.0, and Node 20 or older are outside the tested support matrix. Runtime diagnostics warn for those versions instead of blocking execution solely because of the Node version.
- **Compile-first runtime contract:** `src/**/*.ts` is the source of truth, `src/bin/garda.ts` compiles into the public `bin/garda.js` launcher, and that launcher executes compiled JavaScript from `dist/src/**/*.js` or the staged `.node-build/src/**/*.js` test build. Raw `src/**/*.ts` files are never executed directly.
- **Compiled-only npm package:** published tarballs include `dist/**`, `bin/garda.js`, templates, metadata, and public documentation, but omit the repository `src/**` and `tests/**` trees. Consumer installs do not require TypeScript, devDependencies, or a build step.
- **Strict TypeScript means compiler-enforced typing across all maintained code paths:** `tsconfig.build.json` runs `strict:true` for `src/**/*.ts`, and the wider repo graph (`tsconfig.node-foundation.json` / `tsconfig.tests.json`) covers `src/**/*.ts`, `tests/node/**/*.ts`, and `scripts/node-foundation/**/*.ts`.
- **Release validation is explicit:** `npm run release:preflight` runs static readiness, a short `test:release-smoke` runtime-contract suite, then the full `validate:release` proof. `npm run validate:release` still requires a clean tracked/untracked worktree, proves `build -> embedded bundle parity when present -> regular tests/coverage -> explicit package smoke -> pack/install/invoke`, and checks the worktree again before release handoff.
- **GitHub Actions CI mirrors the release hot path with fast quality coverage:** `ci.yml` runs `typecheck`, focused test shards, `validate:release:fast` on Linux and Windows, pack/install smoke, and a cross-platform lifecycle smoke that installs from the current workflow branch instead of drifting to the repository default branch. The local release handoff remains stricter: `npm run release:preflight` ends with the full `validate:release` proof.
- Root `tsconfig.json` extends `tsconfig.node-foundation.json`, so editors like IntelliJ IDEA or WebStorm can discover the repository without custom setup.

| Node.js line | 1.4.x support status | Release/CI contract |
|---|---|---|
| Node 24 LTS | Official primary runtime | `package.json` allows `>=24.0.0`; GitHub Actions typecheck, unit, release validation, and cross-platform smoke run on Node 24. |
| Node 22.13+ LTS | Official compatibility runtime | `package.json` allows `^22.13.0`; GitHub Actions typecheck, unit, release validation, and cross-platform smoke run on Node 22.13+. |
| Node 23, Node 22 before 22.13, and Node 20 or older | Untested / not officially supported | Outside the `^22.13.0 || >=24.0.0` support matrix. Doctor warns, but runtime version mismatch alone is warning-only. |

## Documentation

| Document | Description |
|---|---|
| **[HOW_TO.md](HOW_TO.md)** | Step-by-step user guide |
| **[docs/cli-reference.md](docs/cli-reference.md)** | Complete CLI command reference |
| **[docs/architecture.md](docs/architecture.md)** | Design, runtime model, deployed files |
| **[docs/configuration.md](docs/configuration.md)** | Token economy, output filters, review capabilities, and review catalog management |
| **[docs/findings-contracts.md](docs/findings-contracts.md)** | Findings-only review lifecycle, policy, recovery, and legacy migration |
| **[docs/node-platform-foundation.md](docs/node-platform-foundation.md)** | Node foundation, execution model, validators, and build/test skeleton |
| **[docs/database/sqlite-persistence.md](docs/database/sqlite-persistence.md)** | Workspace-local derived SQLite catalog, authority boundary, recovery, and maintenance contract |
| **[docs/database/sqlite-query-adoption-evidence.md](docs/database/sqlite-query-adoption-evidence.md)** | Benchmark evidence for adopted and rejected SQLite query paths |
| **[docs/release-readiness.md](docs/release-readiness.md)** | Versioned static release checklist and package handoff contract |
| **[docs/work-example.md](docs/work-example.md)** | Task lifecycle walkthrough |
| **[AGENT_INIT_PROMPT.md](AGENT_INIT_PROMPT.md)** | Setup prompt for coding agents |
| **[CHANGELOG.md](CHANGELOG.md)** | Full changelog |
| **[MANIFEST.md](MANIFEST.md)** | Bundle file manifest |

## Release Background

Garda was not started from scratch in this repository. Earlier versions were developed privately as shell/Python prototypes before being rewritten and consolidated into the current Node/TypeScript implementation. This public repository intentionally starts from the first stable public release, `v1.0.0`, so the earlier internal incubation history is not reflected in the public commit log.

## Recent Changes

- A guarded review catalog now supports repository-specific review lanes, profile states, dependency order, CLI management, and matching local UI controls.
- Active task cycles freeze their effective review catalog and policy, so later configuration changes cannot rewrite in-flight review requirements.
- Authenticated review remediation can reuse valid evidence or run a bounded `DELTA` review; stale, ambiguous, protected, or oversized changes fall back to `FULL` review.
- Review correction, recovery, follow-up, reuse, and closeout paths now retain stricter cycle, scope, launch, and evidence provenance.
- Declarative lifecycle and workflow-settings manifests keep runtime routing, help, documentation, configuration, and UI behavior aligned.
- `garda uninstall` preserves `TASK.md` by default; removing the task queue now requires the explicit `--keep-task-file no` override.

See **[CHANGELOG.md](CHANGELOG.md)** for the complete release notes.

## Important Notes

- `garda setup` can collect the 6 init answers itself and write `runtime/init-answers.json` without an agent.
- After CLI setup or update, use `AGENT_INIT_PROMPT.md` so the agent reuses existing init answers, clarifies language when it cannot recognize it confidently, explicitly confirms which agent entrypoint files are actively used, initializes or refreshes `live/docs/project-memory/**` from repository evidence, optionally manages built-in skill packs, and finishes with the hard `garda agent-init` gate. After `garda agent-init` passes, run `garda ui --actions` to inspect workspace state and guarded allow-listed settings; mutating actions still require confirmation.
- Setup and update reports always include the canonical project-memory init/refresh handoff prompt because users may be upgrading from stale or template-seeded memory.
- With a valid `runtime/agent-init-state.json`, `garda status` and `garda preprompt task` surface the state-gated project-memory init/refresh prompt while the state does not yet record both `ProjectMemoryInitialized=true` and `ProjectMemoryValidated=true`. Malformed agent-init state is reported as invalid first; rerun `garda agent-init` after repair so the memory readiness fields can be trusted. Once both flags are true, green-path task startup does not ask for full memory initialization again.
- Optional skills are discovered from the compact `live/config/skills-index.json` index. After the user selects a built-in pack, it should be installed into `live/skills/**` without reading the full optional `SKILL.md` immediately. Full optional skill files should be opened only later, when the selected skill is actually activated for a task or a hard activation rule requires it.
- `garda` without arguments is now non-destructive and only prints overview/help.
- The public CLI owns the validated runtime surface for lifecycle commands and gate routes.
- Update trust is allowlist-first by default. Any bypass for local paths or non-standard update sources must be explicit via `--trust-override --no-prompt`, and ordinary CLI flows ignore the legacy `GARDA_UPDATE_TRUST_OVERRIDE` environment variable.
- Lock diagnostics cover task-event locks under `garda-agent-orchestrator/runtime/task-events/*.lock` and review-artifact locks under `garda-agent-orchestrator/runtime/reviews/*.lock`. Use `garda doctor --cleanup-stale-locks --dry-run` before removing stale lock directories.
- `bin/garda.js` is a generated launcher compiled from `src/bin/garda.ts`; repository builds run from `dist/src/**/*.js`, tests can stage `.node-build/src/**/*.js`, and packaged installs invoke the same compiled contract from `node_modules`.
- Root `tsconfig.json` is the editor-facing entrypoint and simply extends `tsconfig.node-foundation.json`.
- Installer is non-destructive for existing project files outside managed blocks.
- Commit message format is project-defined; conventional commits are optional.
- For detailed deployment, lifecycle, and configuration information, see the `docs/` directory.

## Support GARDA

GARDA is an independent open-source project for governed AI coding workflows.

Support helps cover AI tokens, model subscriptions, release validation,
documentation, compatibility testing, and maintenance.

- Ko-fi: https://ko-fi.com/gardaworkflow
- Crypto: https://nowpayments.io/donation/garda

## License

Apache License 2.0. See `LICENSE`.

## Author

- Dmytro Shubchynskyi
- Email: d.shubchynskyi@gmail.com
- LinkedIn: https://www.linkedin.com/in/shubchynskyi
