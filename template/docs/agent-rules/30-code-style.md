# Code Style

Primary entry point: selected source-of-truth entrypoint for this workspace.

## Purpose
Define the default style contract agents should follow until stable
repository-specific conventions replace or refine it.

## Global Rules
- Prefer small, focused, testable units and explicit naming.
- Prefer thin entrypoints and handlers over mixing parse, validate, execute,
  render, and persistence concerns in one place.
- Keep public contracts stable unless the task explicitly changes them.
- Follow explicit project rules first, not vague habit or local drift.
- If formatter, linter, or static-analysis config exists, treat it as
  enforceable source of truth.
- Do not copy inconsistent, legacy, or obviously low-quality patterns just
  because they already exist in the repository.
- Avoid style-only churn that does not improve readability, maintainability, or
  correctness.

## Style Priority Order
- Explicit repository-owned conventions and formatter, linter, and static-analysis configs take precedence over vendor style defaults.
- Apply the defaults in this file only where the project has no applicable convention; naming and language examples do not restrict supported stacks.
- Strong, consistent patterns from high-quality project modules may refine local style decisions.
- Common best practices are the fallback when project-specific guidance is missing.

## Comments
- Keep comments only for rationale, invariants, security-sensitive constraints,
  provider or platform quirks, or real boundary exceptions.
- Remove section banners, step narration, line-by-line paraphrases, and JSDoc
  for self-explanatory typed helpers.
- If a block is understandable only because of a prose comment, simplify the
  code first.

## Naming
- Internal code uses `camelCase`.
- Type-like symbols use `PascalCase`.
- Do not prefix interfaces with `I`.
- Boolean helpers should read like questions: `is*`, `has*`, `can*`,
  `should*`.
- Prefer intent-first helper names such as `resolve*`, `read*`, `parse*`,
  `build*`, `format*`, and `print*`.

## Constants and Boundary Shapes
- Use `UPPER_SNAKE_CASE` only for real module-level constants such as stable
  defaults, registries, regex or token maps, CLI option definitions, and other
  long-lived declarations.
- Keep local computed values in normal local naming style even when immutable.
- Keep `snake_case` at external boundaries only, such as JSON, persisted
  artifacts, manifests, CLI or wire contracts, and serialized evidence. Prefer
  `camelCase` inside modules.

## Module Shape
- Prefer one main responsibility per file.
- Preferred small-module reading order: imports -> types or contracts ->
  constants or definitions -> pure helpers -> effectful helpers -> exported
  entrypoint.
- For handler or command modules, prefer parse -> validate -> execute or
  use-case -> render.

## Bootstrap and Refinement
- On a fresh or low-code repository, use this contract plus tooling defaults
  until stable project-specific conventions exist.
- Promote durable repository-specific refinements into
  `project-memory/conventions.md` instead of scattering them across ad-hoc
  local notes or generated materializations.
- Remove unused language or framework placeholders instead of leaving stale
  guidance behind.

## Definition of Done for Style
- Rules above must match actual stack from `live/project-discovery.md`.
- Repository-specific conventions in `project-memory/conventions.md` replace
  conflicting vendor style defaults. Workflow, authorization, and evidence requirements remain mandatory.
