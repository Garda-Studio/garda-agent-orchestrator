# Operating Rules

Primary entry point: selected source-of-truth entrypoint for this workspace.

## General
1. Always read the file before editing.
2. Follow `garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md` for end-to-end task lifecycle.
3. Follow existing project code style and stack constraints from `10-project-context.md` and `30-code-style.md`.
4. Do not create files unnecessarily.
5. Reuse existing utilities and helpers.
6. Respect gitignore boundaries for orchestration control-plane files; ignored `TASK.md`, `garda-agent-orchestrator/runtime/**`, and internal orchestrator docs are expected.
7. Never use `git add -f` / `git add --force` to stage ignored orchestration files just to satisfy gates or documentation bookkeeping.
8. If doc-impact or audit trail requires updates to ignored orchestrator files, write them on disk and continue without expanding the project commit scope unless the user explicitly asks for it; files under the Garda bundle are never staged in an installed project.

## Command Output Discipline
1. Default to compact command output for everyday shell usage; start with summary, bounded, structured, or path-scoped output.
2. Apply command escalation in order: `scan -> inspect -> debug`.
3. Do not jump to verbose or full-output commands on first pass when a compact equivalent exists.
4. Use full output immediately only for security/auth/secrets/migrations/infra-sensitive diagnostics, unfamiliar tool output, or single-target failure debugging.
5. Before switching from compact to verbose/full output, state briefly why the compact pass was insufficient.

## Execution Depth
1. Resolve execution depth from user request as `depth=1`, `depth=2`, or `depth=3`; default is `depth=2`.
2. Treat depth as context and validation rigor profile, not as a way to bypass mandatory gates.
3. Apply automatic escalation after preflight:
   - `FULL_PATH` requires minimum `depth=2`.
   - required specialized review (`security`, `db`, `refactor`, or enabled optional specialist review) requires minimum `depth=2`.
4. Use profile scope:
   - `depth=1`: read `00-core.md`, `80-task-workflow.md`, and directly touched module context only.
   - `depth=2`: read `00/10/20/40/50/60/80/90` plus touched module context.
   - `depth=3`: read `depth=2` set plus `30/35/70` and perform cross-module edge-case checks.
   - when token economy is active and the task stays safely at `depth=1`, prefer the short-form guidance in `garda-agent-orchestrator/live/skills/orchestration-depth1/SKILL.md` instead of loading the full orchestration skill.
5. Record selected depth and any escalation in `TASK.md` notes.

## Stack-Specific Rules
1. Do not assume a language or framework unless confirmed in `10-project-context.md` or `live/project-discovery.md`.
2. If language-specific guidance is missing, add it to `30-code-style.md` before making broad refactors.
3. Do not apply framework-specific patterns from another ecosystem (for example Java patterns in Python projects).
4. Keep commands and runbooks in `40-commands.md` aligned with actual project tooling.

## Project Memory Write Protocol
1. When an agent discovers a durable project fact during task execution (architecture insight, convention, stack detail, domain constraint, design decision), it must append or update the relevant file in `garda-agent-orchestrator/live/docs/project-memory/` as a compact project map entry.
2. Target file selection:
   - Business domain, goals, scope → `context.md`.
   - Component boundaries, data flow, integration points → `architecture.md`.
   - Coding standards, naming rules, workflow conventions → `conventions.md`.
   - Languages, frameworks, infrastructure, dependencies → `stack.md`.
   - Current commands, validation paths, and operator runbooks → `commands.md`.
   - Module ownership and test/source routing → `module-map.md`.
   - Active risks and fragile contracts → `risks.md`.
   - Architectural or process decisions with rationale → `decisions.md`.
   - If no existing file fits, create a new kebab-case `.md` file with a level-1 heading.
3. Write only confirmed, user-approved facts; do not speculate or store transient task details, per-task narratives, large command outputs, or duplicated known orchestrator issues.
4. Prefer updating an existing domain section over appending a new chronological task section. Task ids may be included as provenance, but should not be the default heading structure.
5. Each write must preserve durable existing content while removing or collapsing stale task-log style repetition when the task explicitly scopes memory maintenance.
6. After writing, note the update in the task completion summary so the user can review.

## DevOps
1. Do not commit secrets.
2. Use `.env` for local setup.
3. Validate deployment or infrastructure changes using project-native tooling before commit.

