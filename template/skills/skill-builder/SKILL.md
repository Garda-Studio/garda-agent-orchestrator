---
name: skill-builder
description: Create project-owned specialist skills and wire requested declarative review lanes. Use for explicit skill or review-pipeline customization, not ordinary task implementation or mandatory reviewer execution.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Edit
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.1.0
---

# Skill Builder

Create project-specific skills only in `garda-agent-orchestrator/live/skills/**`.
Never modify shipped templates to install a project skill. A skill contains
`skill.json`, `SKILL.md` and its declared optional `references/*` files.

## Inputs

Reuse choices already supplied by the operator: skill purpose, required or optional
use and trigger semantics. Ask only about unresolved consequential choices; do not
repeat answered questions. This does not waive the exact catalog transaction's
confirmation boundary.

## Workflow

1. Read `references/authoring-principles.md`, `references/skill-template.md`,
   `references/frontmatter-guide.md` and `references/wiring-checklist.md`.
2. Inspect `skills --help`, installed skills and `review-catalog --help` through the
   repository's Garda CLI. Built-in packs provide maintained specialists; built-in
   review lanes have fallback skills. A general-purpose custom skill may remain
   optional. A declarative custom review lane can bind a custom specialist through
   the supported catalog; it does not require a new runtime adapter.
3. Create only the requested live skill. Validate its manifest and references using
   the existing skills validation surface. Use the findings-only reviewer example
   when it will serve a mandatory lane.
4. Follow the wiring checklist's preview, confirmation and apply transaction for
   catalog creation, enablement, profile binding and dependencies. Inspect the
   actual plan before confirmation. Do not directly mutate review capabilities,
   profiles, verdict tokens or the immutable current-task snapshot.
5. Validate catalog resolution and inspect the resulting lane/skill binding.
   Changes apply to future task snapshots. Preserve existing custom skills,
   project memory and user-owned documentation.

## Reviewer boundary

The generated role prompt, prompt template and output template are authoritative
for each launch. A mandatory reviewer returns one findings-only JSON object,
covering every assigned obligation. It writes only the exact ReviewOutputPath,
never edits source or task state, runs Garda, launches another agent or invents
a verdict/receipt. Only the narrow focused check explicitly permitted by the
generated handoff may be executed. Standalone advice is not mandatory review
evidence. Unsupported real delegation must be reported honestly.

## Output

List actual created paths, accepted catalog changes, validation results and any
remaining limitation. Do not claim a preview changed settings or completed a review.
