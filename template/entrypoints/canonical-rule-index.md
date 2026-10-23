<!-- garda-agent-orchestrator:managed-start -->
# canonical-rule-index.md
<!-- markdownlint-disable MD040 -->

# Garda Agent Orchestrator Rule Index

This file can serve as the source of truth for agent workflow rules.
At setup, source of truth is selected via `-SourceOfTruth` ({{SOURCE_OF_TRUTH_VALUES}}).
Non-selected entrypoint files must only redirect to the selected source-of-truth file.

## How To Use This File
1. Always read `garda-agent-orchestrator/live/docs/agent-rules/00-core.md`.
2. Read only the linked rule files required for the current task.
3. Avoid loading unrelated rule files to save context and tokens.
4. Use compact command protocol from `40-commands.md`: first `scan`, then `inspect`, then verbose `debug` only by exception.
5. The `40-commands.md` restraint applies only to standalone ad-hoc commands. It does NOT exempt mandatory gates: gates like `compile-gate` and `full-suite-validation` must execute their underlying build/test/type-check commands when the workflow requires them. See `00-core.md` § Mandatory Infrastructure Integrity.

## Hard Stop For Task Execution
- Not every request is a task: answer questions, explanations, reviews of existing code, read-only commands, status checks and Garda setup (`agent-init`) directly, without a `TASK.md` row or task mode. Change code or config only through task mode for a `TASK.md` row that already exists or that the user explicitly asks to add. If a change is needed and no row matches, propose a row (ID, title, scope) or a `CAND-<number>` candidate and wait for the user's decision; never add a row and enter it without that decision.
- Before implementing any task, open `TASK.md`.
- Before implementing any task, open `.agents/workflows/start-task.md`.
- Do not execute task work until this canonical file and `TASK.md` are both read.
- Treat `.agents/workflows/start-task.md` as the shared start-task router for root entrypoints and provider bridges; it routes to the canonical workflow and does not replace `80-task-workflow.md`.
- Execute tasks only through orchestration workflow (``Execute task <task-id> from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.``), with preflight and required review gates.
- At fresh main-agent task start, show one English start marker from the repo-owned list once in the first relevant reply; this UX marker is not gate evidence.
- Do not use start-marker presence or exact text as hard evidence for task-mode, compile, review, completion, or task-audit gates.
- Reviewer agents, sub-agents, sidecars, and resumed cycles that already passed the start-banner step must not repeat it.
- Mandatory required reviewer launches must spawn a new clean-context delegated reviewer for the current review context; do not create, reserve, hold, or complete a reviewer before launch input exists, and do not reuse an existing reviewer session.
- After the review receipt is persisted, close or release the reviewer sub-agent session.
- Active profile selection comes from `garda-agent-orchestrator/live/config/profiles.json` and the `TASK.md` `Profile` column; do not present `depth=<1|2|3>` as normal user task-start guidance.
- If the workspace already contains modified files before task-mode entry and the run is not isolated through staged or explicit scope, stop and treat the start as invalid.
- After opening downstream workflow files (`40-commands.md`, `80-task-workflow.md`, `90-skill-catalog.md`, and any risk-specific rule pack), record them via `node bin/garda.js gate load-rule-pack ...` in a self-hosted source checkout, or `node garda-agent-orchestrator/bin/garda.js gate load-rule-pack ...` inside a materialized/deployed workspace.
- If provider-native agent directories are available, execute through provider bridge profiles (`.github/agents/orchestrator.md`, `.windsurf/agents/orchestrator.md`, `.junie/agents/orchestrator.md`, `.antigravity/agents/orchestrator.md`).
- Provider bridge profiles must resolve skills and lanes from `garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md`, `garda-agent-orchestrator/live/config/review-capabilities.json`, and the immutable current-task review snapshot (including skills added after init). They must not load the full optional `review-catalog.json` during normal task or reviewer execution.

## Rule Routing
| Task context | File to read |
|---|---|
| Language, communication, code quality | `garda-agent-orchestrator/live/docs/agent-rules/00-core.md` |
| Project goals and tech stack | `garda-agent-orchestrator/live/docs/agent-rules/10-project-context.md` |
| Durable project memory summary | `garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md` |
| System architecture and data or event flow | `garda-agent-orchestrator/live/docs/agent-rules/20-architecture.md` |
| Code style and language conventions | `garda-agent-orchestrator/live/docs/agent-rules/30-code-style.md` |
| Strict SOLID rules and quality gates | `garda-agent-orchestrator/live/docs/agent-rules/35-strict-coding-rules.md` |
| Command policy and available task commands | `garda-agent-orchestrator/live/docs/agent-rules/40-commands.md` |
| Repository structure and documentation map | `garda-agent-orchestrator/live/docs/agent-rules/50-structure-and-docs.md` |
| Operating workflow rules | `garda-agent-orchestrator/live/docs/agent-rules/60-operating-rules.md` |
| Security constraints and mandatory controls | `garda-agent-orchestrator/live/docs/agent-rules/70-security.md` |
| Task lifecycle and independent review process | `garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md` |
| Mandatory skill catalog and invocation policy | `garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md` |

## Rule Files
- `garda-agent-orchestrator/live/docs/agent-rules/00-core.md`
- `garda-agent-orchestrator/live/docs/agent-rules/10-project-context.md`
- `garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md`
- `garda-agent-orchestrator/live/docs/agent-rules/20-architecture.md`
- `garda-agent-orchestrator/live/docs/agent-rules/30-code-style.md`
- `garda-agent-orchestrator/live/docs/agent-rules/35-strict-coding-rules.md`
- `garda-agent-orchestrator/live/docs/agent-rules/40-commands.md`
- `garda-agent-orchestrator/live/docs/agent-rules/50-structure-and-docs.md`
- `garda-agent-orchestrator/live/docs/agent-rules/60-operating-rules.md`
- `garda-agent-orchestrator/live/docs/agent-rules/70-security.md`
- `garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md`
- `garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md`
<!-- garda-agent-orchestrator:managed-end -->
