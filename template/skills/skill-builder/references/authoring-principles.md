# Authoring Principles

This reference distills the useful parts of Anthropic's skill-building guidance into Garda-specific rules for creating new `live/skills/**` content.

## Keep each skill narrow

- One skill should own one clear workflow or review focus.
- If a draft skill needs multiple unrelated outcomes, split it before writing files.
- Prefer concrete names like `api-review` or `dependency-review` over broad helpers like `general-review`.

## Optimize for progressive disclosure

- Put discovery signals in `skill.json`: compact summary, realistic aliases, and only the references that should be opened on demand.
- Put the activation workflow in `SKILL.md`.
- Put long checklists, examples, and edge-case material in `references/*` instead of bloating `SKILL.md`.

## Write discovery metadata for real triggers

- `summary` should explain the value of the skill in one sentence.
- `aliases` should mirror phrases a user would actually type.
- `description` in frontmatter should say what the skill does, when to use it, and when not to use it.
- Add negative triggers when a nearby but different workflow would create noise.

## Pick the right level of prescription

- Use short text workflows when the agent needs judgment.
- Use checklists when outputs must be consistent across runs.
- Add scripts or assets only when the workflow is brittle enough that prose is not reliable.

## Keep token cost low

- Do not restate model-common knowledge just to sound thorough.
- Prefer one strong example over a long wall of explanation.
- Move optional detail into focused references so the base skill stays small.

## Validate with realistic prompts

- Test the draft against 2-3 natural requests a teammate would actually use.
- Check that the skill can be discovered from metadata alone before assuming the full `SKILL.md` will be read.
- Validate mandatory lanes through the existing declarative review catalog and generated findings-only handoff, including supported custom lane IDs.

## Garda-specific adaptations

- Create project-specific specialist skills only under `garda-agent-orchestrator/live/skills/**`.
- Keep the skill manifest, instructions and references consistent. Use guarded catalog preview/confirmation/apply for mandatory lane wiring; prose triggers do not alter policy.
- A general-purpose custom skill can remain optional. A supported declarative custom lane may be mandatory after explicit profile binding; never fabricate delegation when the client cannot launch a real reviewer.
