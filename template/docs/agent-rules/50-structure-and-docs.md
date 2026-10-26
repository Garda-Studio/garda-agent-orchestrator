# Structure and Documentation

Primary entry point: selected source-of-truth entrypoint (depends on configured provider).

## Repository Structure
```text
<ProjectRoot>/
├── AGENTS.md                     # Shared Codex/Cursor entrypoint; canonical only when source-of-truth=Codex or Cursor (recommended gitignore)
├── CLAUDE.md                     # Claude entrypoint; canonical only when source-of-truth=Claude
├── GEMINI.md                     # Gemini entrypoint; canonical only when source-of-truth=Gemini
├── QWEN.md                       # Qwen entrypoint; canonical only when source-of-truth=Qwen
├── .claude/settings.local.json   # Optional (when ClaudeOrchestratorFullAccess=true): Claude Code local permission allowlist for the Node CLI
├── .qwen/settings.json           # Optional (only when already present): Qwen context bootstrap (`TASK.md` + current canonical entrypoint)
├── TASK.md                       # Task queue for orchestration (recommended gitignore)
├── .agents/workflows/start-task.md # Shared start-task router for root entrypoints and provider bridges
├── .antigravity/rules.md         # Platform instruction file (recommended gitignore)
├── .github/copilot-instructions.md
├── .github/agents/orchestrator.md # GitHub Agents orchestration profile
├── .github/agents/reviewer.md     # GitHub generic review bridge profile
├── .github/agents/code-review.md  # GitHub code-review bridge profile
├── .github/agents/db-review.md    # GitHub DB-review bridge profile
├── .github/agents/security-review.md # GitHub security-review bridge profile
├── .github/agents/refactor-review.md # GitHub refactor-review bridge profile
├── .github/agents/api-review.md   # GitHub optional API-review bridge profile
├── .github/agents/test-review.md  # GitHub optional test-review bridge profile
├── .github/agents/performance-review.md # GitHub optional performance-review bridge profile
├── .github/agents/infra-review.md # GitHub optional infra-review bridge profile
├── .github/agents/dependency-review.md # GitHub optional dependency-review bridge profile
├── .junie/guidelines.md          # Platform instruction file (recommended gitignore)
├── .junie/agents/orchestrator.md # Junie agent bridge profile
├── .windsurf/rules/rules.md      # Platform instruction file (recommended gitignore)
├── .windsurf/agents/orchestrator.md # Windsurf agent bridge profile
├── .antigravity/agents/orchestrator.md # Antigravity agent bridge profile
└── garda-agent-orchestrator/
    ├── template/                 # Immutable deployment template
    │   ├── skills/**             # Core-skill templates (skill.json + SKILL.md + optional references/agents)
    │   └── skill-packs/**        # Optional-skill pack scaffolds (pack.json + skill.json + SKILL.md)
    ├── live/                     # Active rule and skill set for this project
    │   ├── config/review-capabilities.json # Optional specialist-review capability flags
    │   ├── config/paths.json     # Runtime roots and preflight trigger regexes
    │   ├── config/output-filters.json # Shared gate-output filter profiles
    │   ├── config/skill-packs.json # Installed built-in domain skill packs
    │   ├── config/skills-index.json # Compact optional-skill discovery index
    │   ├── docs/agent-rules/**   # Canonical rule set used by selected source-of-truth routing
    │   ├── docs/changes/CHANGELOG.md
    │   ├── docs/reviews/TEMPLATE.md
    │   ├── docs/tasks/TASKS.md
    │   ├── skills/**             # Skills in a common format: skill.json + SKILL.md + optional references/agents
    │   ├── USAGE.md              # Post-init usage instructions for the selected assistant language
    │   ├── project-discovery.md  # Auto-detected stack and command signals
    │   ├── init-report.md        # Init execution report
    │   └── source-inventory.md   # Discovered legacy docs and agent files
    ├── runtime/
    │   ├── agent-init-state.json # Hard onboarding gate artifact written by `garda agent-init`
    │   ├── reviews/**            # Generated preflight and review artifacts
    │   └── task-events/**        # Task timeline logs by task id
    ├── bin/garda.js            # Public Node CLI entrypoint
    ├── src/**                    # Canonical Node/TypeScript runtime
    ├── MANIFEST.md               # Bundle manifest
    └── AGENT_INIT_PROMPT.md      # Single prompt for setup agent
```

## Core Documents
- Source-of-truth entrypoint file (selected at install): canonical routing index for agent rules.
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `QWEN.md` - supported root entrypoint files; `AGENTS.md` is intentionally shared by Codex and Cursor, and only the selected source-of-truth file is canonical.
- `.claude/settings.local.json` - optional (when `ClaudeOrchestratorFullAccess=true`): Claude Code local permission allowlist for the Node CLI.
- `.qwen/settings.json` - optional Qwen context bootstrap for `TASK.md` plus the current canonical entrypoint (only updated when the file already exists).
- `TASK.md` - canonical task list for agent execution workflow.
- `.agents/workflows/start-task.md` - shared start-task router opened by root entrypoints and provider bridges before task execution.
- `.github/agents/orchestrator.md` - mandatory orchestration profile for GitHub Agents task execution.
- `.github/agents/reviewer.md` and `.github/agents/*-review.md` - GitHub review-profile bridges to canonical `live/skills/*`.
- `.github/agents/api-review.md`, `.github/agents/test-review.md`, `.github/agents/performance-review.md`, `.github/agents/infra-review.md`, `.github/agents/dependency-review.md` - optional specialist bridges (enabled by capability flags).
- `.windsurf/agents/orchestrator.md` - Windsurf orchestrator bridge profile.
- `.junie/agents/orchestrator.md` - Junie orchestrator bridge profile.
- `.antigravity/agents/orchestrator.md` - Antigravity orchestrator bridge profile.
- `garda-agent-orchestrator/live/docs/changes/CHANGELOG.md` - feature and behavior change log.
- `garda-agent-orchestrator/live/docs/reviews/TEMPLATE.md` - canonical review artifact template.
- `garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md` - mandatory skill invocation policy.
- `garda-agent-orchestrator/live/config/paths.json` - configurable preflight path roots and trigger regexes.
- `garda-agent-orchestrator/live/config/output-filters.json` - shared compile/review output filter profiles for gate compaction.
- `garda-agent-orchestrator/live/config/skill-packs.json` - installed built-in domain packs managed by `garda skills`.
- `garda-agent-orchestrator/live/USAGE.md` - post-init usage instructions rendered in the selected assistant language.
- `node garda-agent-orchestrator/bin/garda.js agent-init` - hard code-level onboarding gate that records active agent files and final validation state.
- `node garda-agent-orchestrator/bin/garda.js gate enter-task-mode` - explicit task-mode boundary gate before preflight and implementation.
- `node garda-agent-orchestrator/bin/garda.js gate classify-change` - path mode and required review preflight gate.
- `node garda-agent-orchestrator/bin/garda.js gate compile-gate` - mandatory compile gate before review phase.
- `node garda-agent-orchestrator/bin/garda.js gate required-reviews-check` - mandatory post-review gate checker.
- `node garda-agent-orchestrator/bin/garda.js gate log-task-event` - task timeline event logger by task id.
- `node garda-agent-orchestrator/bin/garda.js gate task-events-summary` - human-readable task timeline summary by task id.
- `node garda-agent-orchestrator/bin/garda.js gate task-audit-summary` - compact task audit showing status, gates, changed files, evidence paths, and blockers.
- `node garda-agent-orchestrator/bin/garda.js gate build-scoped-diff` - reviewer scoped-diff artifact builder with fallback metadata.
- `node garda-agent-orchestrator/bin/garda.js gate build-review-context` - reviewer context artifact builder for token economy rule-pack selection.
- `node garda-agent-orchestrator/bin/garda.js gate validate-manifest` - manifest duplicate-entry validator.
- `garda-agent-orchestrator/live/project-discovery.md` - auto-detected stack signals and suggested command baselines.
- `garda-agent-orchestrator/live/skills/README.md` - common skill format reference.
- `garda-agent-orchestrator/live/skills/orchestration/SKILL.md` - orchestration skill.
- `garda-agent-orchestrator/live/skills/skill-builder/SKILL.md` - optional live-only specialist skill generator and wiring workflow.
- `garda-agent-orchestrator/live/skills/code-review/SKILL.md` - code review skill.
- `garda-agent-orchestrator/live/skills/db-review/SKILL.md` - DB review skill.
- `garda-agent-orchestrator/live/skills/security-review/SKILL.md` - security review skill.
- `garda-agent-orchestrator/live/skills/refactor-review/SKILL.md` - refactor review skill.
- `garda-agent-orchestrator/live/skills/test-review/SKILL.md` - test review skill.

## Orchestrator Git Boundary
- In normal project deployments, local orchestration control-plane files are expected to stay gitignored.
- This includes `TASK.md`, installer-managed provider bridge files, `garda-agent-orchestrator/runtime/**`, and internal orchestrator docs such as `garda-agent-orchestrator/live/docs/changes/CHANGELOG.md`.
- Their absence from `git status`, staged diff, or PR scope is normal and must not be treated as a workflow failure.
- Only stage or version `TASK.md` or provider bridge files when the user explicitly requests it, or when the current repository is the orchestrator bundle source itself. In an installed project, never stage or version paths under `garda-agent-orchestrator/`, even on request.
