# Bundle Manifest

Bundle root: `garda-agent-orchestrator`
Template root: `garda-agent-orchestrator/template`
Live root: `garda-agent-orchestrator/live`

Managed in project root by `garda install` (or `node garda-agent-orchestrator/bin/garda.js install`), depending on source-of-truth, active agent files, and provider bridges:
- CLAUDE.md
- AGENTS.md
- GEMINI.md
- .qwen/settings.json (only when already present in the project)
- TASK.md
- .antigravity/rules.md
- .github/agents/orchestrator.md
- .github/agents/reviewer.md
- .github/agents/code-review.md
- .github/agents/db-review.md
- .github/agents/security-review.md
- .github/agents/refactor-review.md
- .github/agents/api-review.md
- .github/agents/test-review.md
- .github/agents/performance-review.md
- .github/agents/infra-review.md
- .github/agents/dependency-review.md
- .github/copilot-instructions.md
- .junie/guidelines.md
- .junie/agents/orchestrator.md
- .windsurf/rules/rules.md
- .windsurf/agents/orchestrator.md
- .antigravity/agents/orchestrator.md

Unused entrypoints are not created by default. Extra redirect entrypoints appear only after the user explicitly confirms them during `agent-init`.

Versioned bundle templates consumed during materialization:
- template/AGENTS.md
- template/entrypoints/canonical-rule-index.md
- template/docs/agent-rules/** (standard rule templates plus optional support appendices)
- template/config/garda.config.json
- template/config/optional-skill-selection-policy.json
- template/config/update-messages.json
- template/config/workflow-config.json (optional; configures post-task full-suite validation behavior when enabled via user preference)

Materialized (regenerated on every init, reinit, and update) inside `garda-agent-orchestrator/live`:
- live/config/review-capabilities.json
- live/config/paths.json
- live/config/token-economy.json
- live/config/output-filters.json
- live/config/skill-packs.json
- live/config/optional-skill-selection-policy.json
- live/config/isolation-mode.json
- live/config/profiles.json
- live/config/review-artifact-storage.json
- live/config/workflow-config.json (optional; runtime configuration for post-task full-suite validation)
- live/config/skills-index.json
- live/config/update-messages.json
- live/config/garda.config.json
- live/docs/agent-rules/** (template-materialized rules; `15-project-memory.md` is regenerated from `docs/project-memory/` sources)
- live/docs/changes/**
- live/docs/reviews/**
- live/docs/tasks/**
- live/skills/**
- live/source-inventory.md
- live/init-report.md
- live/project-discovery.md
- live/USAGE.md
- live/version.json

User-owned / durable (seeded once on fresh install, never overwritten by init, reinit, update, or uninstall-with-keep):
- live/docs/project-memory/** (`README.md`, `context.md`, `architecture.md`, `conventions.md`, `stack.md`, `decisions.md`, plus any user-added files)

Generated during task execution:
- runtime/reviews/**
- runtime/task-events/**
- runtime/agent-init-state.json

Generated during updates:
- runtime/update-reports/**
- runtime/update-rollbacks/**
- runtime/bundle-backups/**

Removed by `garda uninstall` (or `node garda-agent-orchestrator/bin/garda.js uninstall`):
- the deployed `garda-agent-orchestrator/` bundle directory
- all redirect entrypoints and provider bridge agent files created by install
- the selected primary entrypoint only when the user chooses delete during uninstall
- `TASK.md` only when the user chooses delete during uninstall
- orchestrator-only entries from `.qwen/settings.json`, `.claude/settings.local.json`, `.git/hooks/pre-commit`, and `.gitignore`, while preserving unrelated user content outside managed blocks
- when runtime artifacts are kept, `garda-agent-orchestrator/runtime/**` is copied into `garda-agent-orchestrator-uninstall-backups/<timestamp>/garda-agent-orchestrator/runtime/` before bundle removal; `live/docs/project-memory/**` is also preserved alongside runtime artifacts into the same backup tree

Configured when `EnforceNoAutoCommit=true`:
- .git/hooks/pre-commit (managed guard block)

Kept inside bundle:
- `package.json` (npm package metadata shipped with the source bundle and synced into deployed workspaces during update)
- `bin/garda.js` (generated npm bootstrap/lifecycle/gate CLI compiled from `src/bin/garda.ts`; exposes `garda`, `gao`, and `garda-agent-orchestrator`)
- `src/**` (canonical Node/TypeScript runtime for lifecycle commands, validators, and gates)
- `dist/**` (compiled JavaScript output consumed at runtime)
- template/**
- .gitattributes
- README.md
- CHANGELOG.md
- CONTRIBUTING.md
- HOW_TO.md
- LICENSE
- NOTICE
- TRADEMARKS.md
- SECURITY.md
- docs/assets/garda-github-social-preview.png
- docs/architecture.md
- docs/branch-protection.md
- docs/contributor-workflow.md
- docs/cli-reference.md
- docs/compatibility-matrix.md
- docs/configuration.md
- docs/control-plane-isolation.md
- docs/database/sqlite-persistence.md
- docs/database/sqlite-query-adoption-evidence.md
- docs/findings-contracts.md
- docs/node-platform-foundation.md
- docs/node-runtime-contract.md
- docs/operator-consistency-runbook.md
- docs/orchestrator-work-and-isolation.md
- docs/providers.md
- docs/release-readiness.md
- docs/run-methods.md
- docs/sbom.md
- docs/secret-scanning.md
- docs/task-plan-workflow.md
- docs/threat-model.md
- docs/work-example.md
- AGENT_INIT_PROMPT.md
- MANIFEST.md
- VERSION
- tsconfig.json
- tsconfig.node-foundation.json
