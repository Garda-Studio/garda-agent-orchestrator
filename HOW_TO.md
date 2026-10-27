# Garda Agent Orchestrator: User How-To

Step-by-step guide for project owners. For CLI command details see **[docs/cli-reference.md](docs/cli-reference.md)**.

## 1. Recommended Setup

```shell
npm install -g garda-agent-orchestrator
garda setup
```

This is the recommended path when you want persistent CLI commands:
- `garda`
- `gao`
- `garda-agent-orchestrator`

One-off fallback without global install:

```shell
npx -y garda-agent-orchestrator setup
```

`npx` runs the package temporarily and does not keep `garda` or `gao` in your terminal `PATH`.

Preferred and required runtime surface is the Node CLI.

If you work from a source checkout instead of npm registry artifacts, run `npm install` for dependencies and then `npm run build` explicitly before first use. The package intentionally does not rely on consumer install lifecycle scripts such as `prepare`.

This path:
- deploys `./garda-agent-orchestrator/`;
- asks or accepts the 6 init answers;
- writes `runtime/init-answers.json`;
- runs install;
- validates manifest;
- leaves final agent onboarding for `AGENT_INIT_PROMPT.md` and the hard `garda agent-init` gate.

## 2. Optional Bundle-Only Bootstrap

```shell
garda bootstrap
```

This only deploys `./garda-agent-orchestrator/` and prints next steps.
It does **not** run install.

**Branch testing:**
```shell
garda bootstrap --repo-url "<git-url>" --branch "<branch>"
```

**Manual setup** (without npm):
Copy the full `garda-agent-orchestrator/` directory into your project root.

## 3. Finish Setup Through Agent

Give your coding agent this file:
```
garda-agent-orchestrator/AGENT_INIT_PROMPT.md
```

If CLI setup already created `runtime/init-answers.json`, the agent should reuse it, validate/normalize the saved language, and ask again only when the language is ambiguous or cannot be confidently recognized.
The agent should not repeat the other 5 setup questions when the file is already complete.
However, the agent must still explicitly confirm which agent entrypoint files you actively use when `ActiveAgentFiles` is missing, empty, or still canonical-only after CLI setup.

Only if answers are still missing, the agent will ask you the missing questions. The active agent files question is also mandatory during agent initialization whenever it has not yet been explicitly confirmed:

| # | Question | Options |
|---|---|---|
| 1 | Assistant response language | Any language (e.g. English, Russian) |
| 2 | Default response brevity | `concise` or `detailed` |
| Required during agent init | Active agent files | Multiple values such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `QWEN.md` |
| 3 | Source-of-truth entrypoint | Claude, Codex, Cursor, DeepSeek, Gemini, Qwen, GitHubCopilot, Windsurf, Junie, Antigravity |
| 4 | Hard no-auto-commit guard | `yes` or `no` |
| 5 | Claude full access to orchestrator | `yes` or `no` |
| 6 | Token economy enabled | `yes` or `no` |

After handoff, the agent:
1. Reuses `garda-agent-orchestrator/runtime/init-answers.json` if it is already complete.
2. Normalizes `AssistantLanguage` and asks for clarification only if it cannot confidently recognize the language.
3. Runs install only when primary initialization is incomplete or answers were actually missing.
4. Fills project context from `live/project-discovery.md`.
5. Explicitly confirms active agent files and then runs `garda agent-init`.
6. Returns `Usage Instructions` in your selected language.
7. Asks a mandatory code-style policy question and records the answer in `30-code-style.md`: accept the default of explicit rules + tooling + common best practices, or provide custom project-specific rules now.
8. Offers to add optional built-in skill packs or custom skills.
9. Uses `garda skills suggest` / `garda skills list` for discovery first, installs selected packs without reading their full skill bodies, and opens full optional skill files only when they are actually activated for a task.

## 4. Expected Result

After successful setup:

- ✅ The selected source-of-truth entrypoint exists as the canonical file.
- ✅ Additional active agent files, if explicitly confirmed during agent init, are materialized as redirects or provider bridges.
- ✅ Provider bridge profiles exist (`.github/agents/*.md`, `.windsurf/agents/`, etc.).
- ✅ Canonical rules at `garda-agent-orchestrator/live/docs/agent-rules/`.
- ✅ Config files at `garda-agent-orchestrator/live/config/`.
- ✅ `garda agent-init` passes and writes `runtime/agent-init-state.json`.
- ✅ `garda verify` and `garda gate validate-manifest` pass.
- ✅ `TASK.md` exists with task queue.

See **[docs/architecture.md](docs/architecture.md)** for full list of deployed files.

## 5. Start Working On Tasks

Tell your agent:

```
Execute task T-001 from TASK.md strictly through the orchestrator. Use `next-step` as the navigator before the first gate, after each suggested command, and after failures.
```

The orchestrator navigator prints the current mandatory command, then must be consulted again after each suggested command and after failures. Do not hardcode the gate order in the task prompt; `next-step` owns routing through task-mode, preflight, compile, review, doc-impact, completion, and recovery steps based on current evidence.

The first fresh main-agent execution reply should emit exactly one English start banner from the repo-owned list (`Garda captures my mind` or `Garda rewrites my code`) before any edits and list the first gates it will run.

| Built-in Profile | Behavior | When to Use |
|---|---|---|
| `balanced` | Balanced review/gate policy | Default for most tasks |
| `fast` | Lighter review/gate policy | Small, localized, low-risk tasks |
| `strict` | Strict review/gate policy | High-risk, cross-module, security-sensitive work |
| `docs-only` | Documentation-focused policy | Documentation-only tasks |

The active workspace profile is the default execution mode.
The `TASK.md` `Profile` column controls which profile applies per task (`default` inherits the workspace active profile).
Do not pass `depth=<1|2|3>` in normal task-start prompts; depth is internal gate/profile evidence unless a debug or recovery command explicitly needs an override.

Required gates apply at any depth.
See **[docs/work-example.md](docs/work-example.md)** for a full task lifecycle walkthrough.

## 6. Existing Project With Existing Docs

- Existing docs are read as context input — orchestrator does not move or delete them.
- Canonical rules remain under `garda-agent-orchestrator/live/`.
- Specialist skills are created only in `garda-agent-orchestrator/live/skills/**`.

## 7. Project Memory (Durable Knowledge)

Durable project knowledge lives in `garda-agent-orchestrator/live/docs/project-memory/`.

### What Belongs There

| File | Content |
|---|---|
| `context.md` | Business domain, project goals, scope boundaries. |
| `architecture.md` | Component boundaries, data flow, integration points. |
| `conventions.md` | Coding standards, naming rules, workflow conventions. |
| `stack.md` | Languages, frameworks, infrastructure, key dependencies. |
| `decisions.md` | Architectural and process decisions with rationale. |

Add new files in lowercase kebab-case `.md` format when no existing category fits.

### Ownership and Lifecycle

- `project-memory/` is **user-owned**. The materializer seeds it from templates on fresh install and never overwrites, merges, or deletes its contents on init, reinit, update, or uninstall-with-keep.
- `live/docs/agent-rules/15-project-memory.md` is a **generated summary** regenerated on every init, reinit, and update from the contents of `project-memory/`. Do not edit it directly; edit the source files in `project-memory/` instead.
- Context rule files (`10-project-context.md`, `20-architecture.md`, etc.) now redirect agents to `project-memory/` as the authoritative source. Do not embed durable knowledge in those managed rule files.

### How Agents Use It

- Agents read `project-memory/` files for context at any time.
- Agents write to `project-memory/` only with explicit user approval or a task instruction that authorises the update.
- Discovered facts (architecture insights, conventions, stack details, domain constraints, design decisions) go into the matching `project-memory/` file, not into managed rules or config.

## 8. Post-Init Validation

```shell
garda agent-init --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "AGENTS.md" --project-rules-updated yes --skills-prompted yes
garda doctor --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda doctor --target-root "." --cleanup-stale-locks --dry-run
garda doctor explain COMPILE_GATE_FAILED
garda status why-blocked --target-root "."
garda verify --target-root "." --source-of-truth "<provider>" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda gate validate-manifest --manifest-path "garda-agent-orchestrator/MANIFEST.md"
```

**Provider values:** `Claude`, `Codex`, `Cursor`, `DeepSeek`, `Gemini`, `Qwen`, `GitHubCopilot`, `Windsurf`, `Junie`, `Antigravity`.

For day-to-day validation, prefer `garda doctor`, `garda verify`, and `garda gate validate-manifest`.
Use `garda doctor explain <FAILURE_ID>` when a doctor/gate failure code is known and you want remediation steps, `garda status why-blocked` when a task is stalled and you need the missing-gate or missing-timeline explanation, and `garda doctor --cleanup-stale-locks --dry-run` when task-event locks may be blocking gate writes.
The lock-health workflow covers stale task-event locks under `runtime/task-events/*.lock` and stale review-artifact locks under `runtime/reviews/*.lock`.

See **[docs/cli-reference.md](docs/cli-reference.md)** for the full low-level script reference.

## 9. Change Init Answers (Reinit)

Change language, brevity, source-of-truth, or other init answers without reinstalling:

```shell
garda reinit --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

See **[docs/cli-reference.md](docs/cli-reference.md#garda-reinit)** for details.

## 10. Update Existing Deployment

```shell
# Check only
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"

# Compare and auto-apply for CI
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --apply --no-prompt

# Direct apply
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"

# Apply from git explicitly
garda update git --target-root "." --repo-url "." --check-only
garda update git

# Dry-run preview
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --dry-run

# Roll back the last applied update
garda rollback --target-root "."

# Roll back to a specific orchestrator version
garda rollback --target-root "." --to-version "<target-version>" --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

`check-update` is compare-first and uses `--apply` only when you want it to perform the update.
`update` applies the update workflow directly unless `--dry-run` is used.
`update git` uses a git clone source explicitly; without extra flags it uses the default GitHub repository and applies the update to the current workspace.
`rollback` without `--to-version` restores the latest saved rollback snapshot and bundle backup from the last applied update; with `--to-version` it acquires that version, syncs the bundle, and re-materializes the workspace.

By default `check-update` compares against the deployed package name using the npm `latest` tag. When an update is applied (`check-update --apply` or `update`), the workflow reuses and validates init answers, syncs bundle files, re-materializes `live/`, and only updates `VERSION` after the lifecycle succeeds. For local testing you can point `check-update/update` to `--source-path "."` or to a local tarball via `--package-spec`.
Trusted mode is the default. If you intentionally bypass the trusted-source allowlist for a local path, non-standard npm spec, or non-allowlisted git source, pass both `--trust-override` and `--no-prompt`; the update report will record that override explicitly. Do not rely on `GARDA_UPDATE_TRUST_OVERRIDE` in CI or production-style flows; ordinary CLI updates ignore it.

See **[docs/cli-reference.md](docs/cli-reference.md#garda-update)** for full options.

## 11. Uninstall

```shell
# Interactive — asks what to keep
garda uninstall --target-root "."

# Non-interactive
garda uninstall --target-root "." --no-prompt --keep-primary-entrypoint no --keep-task-file no --keep-runtime-artifacts yes
```

Uninstall removes managed blocks, bridge files, and the bundle directory while preserving user content outside managed sections. It also creates an internal uninstall journal snapshot and attempts automatic restore on failure. Avoid `--skip-backups` unless you explicitly accept losing the user-facing recovery backup copies.
See **[docs/cli-reference.md](docs/cli-reference.md#garda-uninstall)** for full options.

## 12. Adding Specialist Skills After Init

Built-in packs:

```shell
garda skills list --target-root "."
garda skills suggest --target-root "." --task-text "Fix slow API endpoint" --changed-path "src/api/users.ts"
garda skills add java-spring --target-root "."
garda skills remove java-spring --target-root "."
garda skills validate --target-root "."
```

`skills list` and `skills suggest` should be read as two different layers:
- optional pack = installable bundle;
- skill = concrete directory under `live/skills/**` after install.
- baseline skills are already included and optional packs must not duplicate them.

The agent should first show what is already available now: baseline skills, installed optional packs, and installed optional skill directories. Only after that should it suggest additional optional packs to add. `skills suggest` uses only the compact `live/config/skills-index.json` index for discovery and should not recommend baseline skills or already installed optional skills as new additions. After selection, the pack should just be installed into `live/skills/**`; full optional skill files should be read only later, when a selected skill is actually activated for task execution.

Custom project-specific skills still live under `garda-agent-orchestrator/live/skills/**` and can be created via `live/skills/skill-builder/SKILL.md`.

## Runtime Requirements

| Component | Requirement |
|---|---|
| Public CLI and gate commands | Node.js 24 LTS primary; Node.js 22.13+ compatibility |
| Task orchestration workspace | Local Git repository with the `git` CLI available; GitHub/GitLab/other remotes are optional and do not affect local gate logic |

If you work on this repository itself in IntelliJ IDEA/WebStorm, open the root `tsconfig.json`; it extends `tsconfig.node-foundation.json` and is the editor-facing project file.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `garda: command not found` | Global install missing or `PATH` not refreshed | Run `npm install -g garda-agent-orchestrator` and open a new terminal |
| `npx` fetches a stale version | npm cache holds an older package | Run `npx --yes --package garda-agent-orchestrator@latest garda setup` or clear cache with `npm cache clean --force` |
| `EACCES` / permission denied on global install | No write access to the global `node_modules` prefix | Use `sudo npm install -g …` (Linux/macOS) or fix the npm prefix directory permissions |
| Runtime diagnostics warn about an unsupported Node.js version | Active Node version is outside `^22.13.0 || >=24.0.0` | Use Node.js 24 LTS for the primary runtime path, or Node.js 22.13+ for the compatibility line |
| `garda verify` fails after update | `live/` materialization is out of sync with new templates | Run `garda init --target-root "."` to re-materialize, then `garda verify` again |
| `validate-manifest` reports duplicate keys | MANIFEST.md has repeated file entries | Remove the duplicate lines in `MANIFEST.md` and rerun `garda gate validate-manifest` |
| Agent skips init answers and re-asks all 6 questions | `runtime/init-answers.json` missing or unreadable | Verify the file exists and the path passed to the agent matches; rerun `garda setup` if lost |
| Rollback fails with "no snapshot found" | No prior update created a rollback snapshot | Use `garda update --dry-run` first; rollback is only available after a successful `update` or `check-update --apply` |

## Further Reading

- **[docs/architecture.md](docs/architecture.md)** — Design, runtime model, what gets deployed
- **[docs/configuration.md](docs/configuration.md)** — Token economy, output filters, review capabilities
- **[docs/cli-reference.md](docs/cli-reference.md)** — Complete CLI command reference
- **[docs/findings-contracts.md](docs/findings-contracts.md)** — Findings-only review lifecycle and legacy migration
- **[docs/database/sqlite-persistence.md](docs/database/sqlite-persistence.md)** — Workspace-local SQLite projection, recovery, and authority boundary
- **[docs/database/sqlite-query-adoption-evidence.md](https://github.com/Garda-Studio/garda-agent-orchestrator/blob/master/docs/database/sqlite-query-adoption-evidence.md)** — Measured SQLite query adoption evidence
- **[docs/release-readiness.md](https://github.com/Garda-Studio/garda-agent-orchestrator/blob/master/docs/release-readiness.md)** — Versioned release checklist and package handoff contract
- **[docs/work-example.md](docs/work-example.md)** — Task lifecycle walkthrough
- **[CHANGELOG.md](CHANGELOG.md)** — Full changelog
