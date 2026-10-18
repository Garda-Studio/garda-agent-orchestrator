# Wiring Checklist

1. Reuse the requested skill, scope and mandatory/optional choices. Ask only for unresolved consequential choices.
2. Inspect installed skills and the current `skills --help` / `review-catalog --help` command surfaces. Prefer an existing built-in pack or fallback skill when it meets the request. A general-purpose custom skill is not automatically a review lane.
3. Create project-owned files only under `garda-agent-orchestrator/live/skills/<skill-id>/`. Validate the manifest and every declared reference. Preserve other custom skills and project memory.
4. For a mandatory custom lane, use a declarative `review-catalog create` definition naming the installed skill, then the supported enable/profile-bind/dependency operations. Custom lanes are supported; do not invent verdict tokens or replace built-in lanes. Prose triggers alone cannot make a lane mandatory.
5. Each catalog mutation is preview-only without a phase flag. Review the exact state and plan hashes, obtain the required real operator confirmation, confirm that preview, and apply its one-time receipt. Use `review-catalog --help` and the CLI reference for current flags. Never edit capabilities, profiles or catalog JSON to bypass this transaction.
6. Validate the resulting catalog/profile/dependency resolution and inspect the chosen skill binding. Changes affect future task snapshots; never rewrite the immutable active-task review snapshot.
7. The generated reviewer handoff owns output shape and command authority. The reviewer returns findings-only JSON, writes only the assigned ReviewOutputPath and stops. No agent-created PASS, native receipt or fabricated delegation.
8. Report actual files and catalog changes, validation and remaining limitations. If real independent delegation is unavailable, report that limitation rather than claiming a mandatory review occurred.
