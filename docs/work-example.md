# Work Example

This example shows the current Garda task loop. The exact command is always
the one printed by `garda next-step`; the commands below show the shape of the
flow, not a replacement for the navigator.

## Creating Tasks

User asks:
> Create a task in TASK.md for feature "Invoice CSV export with email delivery".

Agent splits it into subtasks in `TASK.md`:

| ID | Status | Priority | Area | Title | Profile | Notes |
|---|---|---|---|---|---|---|
| T-201 | TODO | P1 | backend | Add invoice CSV export API and service | strict | Requires runtime + API review path |
| T-202 | TODO | P1 | worker | Add async email delivery job for exported CSV | strict | Requires security review for outbound attachment flow |
| T-203 | TODO | P2 | docs | Update docs/changelog and user-facing usage notes | default | Depends on T-201 and T-202 |

## Executing a Task

User asks:
> Execute task T-201 strictly through the orchestrator.

The agent starts with the navigator and reruns it after every suggested command:

```shell
garda next-step T-201
```

In a source checkout the equivalent developer command is:

```shell
node bin/garda.js next-step T-201
```

## Happy Path

```text
 1. Run next-step                     -> enter-task-mode command printed
 2. Enter task mode                   -> TASK_MODE_ENTERED
 3. Rerun next-step                   -> load-rule-pack TASK_ENTRY
 4. Load TASK_ENTRY rules             -> RULE_PACK_LOADED
 5. Rerun next-step                   -> handshake-diagnostics
 6. Run handshake diagnostics         -> HANDSHAKE_DIAGNOSTICS_PASSED
 7. Rerun next-step                   -> shell-smoke-preflight
 8. Run shell smoke preflight         -> SHELL_SMOKE_PREFLIGHT_PASSED
 9. Rerun next-step                   -> classify-change
10. Classify changes                  -> PREFLIGHT_CLASSIFIED
11. Rerun next-step                   -> POST_PREFLIGHT rule load or bind
12. Load or bind POST_PREFLIGHT rules -> RULE_PACK_LOADED
13. Implement code and tests          -> working tree changes exist
14. Rerun next-step                   -> compile-gate
15. Run compile gate                  -> COMPILE_GATE_PASSED
16. Rerun next-step                   -> full-suite-validation if enabled
17. Run full suite when required      -> FULL_SUITE_VALIDATION_PASSED
18. Rerun next-step                   -> build-review-context for launchable lanes
19. Build review context              -> reviewer prompt/context artifacts
20. Launch fresh delegated reviewer   -> clean-context reviewer session
21. Record reviewer output            -> REVIEW_RECORDED
22. Close reviewer session            -> reviewer is no longer reused
23. Rerun next-step                   -> required-reviews-check
24. Run required reviews check        -> REVIEW_GATE_PASSED
25. Rerun next-step                   -> doc-impact-gate
26. Record docs decision              -> DOC_IMPACT_GATE_PASSED
27. Rerun next-step                   -> project-memory-impact when enabled
28. Record project memory impact      -> current project-memory evidence
29. Rerun next-step                   -> completion-gate
30. Run completion gate               -> COMPLETION_GATE_PASSED
31. Rerun next-step                   -> task-audit-summary
32. Materialize final closeout        -> final closeout JSON/Markdown
33. Rerun next-step                   -> DONE
34. Deliver final report              -> review attestation, summary, commit question
```

## Failed Review Recovery

Review failure is not a shortcut to completion. A failed current-cycle review
must be remediated, then routed through `next-step` again. Depending on the
changed files, Garda may refresh preflight, rerun compile, rebuild scoped diff
metadata, reuse still-valid upstream PASS lanes, or require fresh reviewers.

Example: API review fails because the CSV export endpoint omits a pagination
limit.

```text
 1. Code and API review contexts are built from current preflight.
 2. Fresh delegated code reviewer returns REVIEW PASSED.
 3. Fresh delegated API reviewer returns API REVIEW FAILED with findings.
 4. record-review-result persists the failed API review.
 5. required-reviews-check fails because API review is not PASS.
 6. Agent fixes the pagination limit and adds tests.
 7. Agent reruns next-step.
 8. next-step routes the smallest valid recovery chain:
    - classify-change if the workspace diff changed,
    - POST_PREFLIGHT load/bind,
    - compile-gate,
    - full-suite-validation when placement requires it,
    - build-review-context for the failed or invalidated review lane.
 9. Agent launches a new clean-context API reviewer for the new context.
10. Agent records the new API reviewer output.
11. required-reviews-check passes only after current-cycle review evidence is PASS.
12. Agent continues to doc-impact, project-memory, completion, task-audit, and final report.
```

If a previous PASS lane is still valid, `next-step` may route through
`build-review-context` to materialize current-cycle reuse evidence instead of
relaunching that reviewer. That reuse is gate-owned and hash/provenance-bound;
the implementation agent must not decide on its own that a stale review can be
treated as current.

## Review Output Recording

Reviewer output should normally be recorded exactly from the delegated reviewer
response:

```shell
garda gate record-review-result --task-id "T-201" --review-type "api" --review-output-stdin
```

Compatibility with `--review-output-path` remains, but agents must not invent,
rewrite, or summarize a missing reviewer artifact. If the delegated reviewer did
not produce usable output, launch a new reviewer or stop and report the blocker.

## Depth And Profiles

Depth is derived from the active profile and current risk. Users normally pick a
task profile in `TASK.md`; agents should not treat `depth=1|2|3` as a review
waiver.

| Depth | Typical Use | Review Effect |
|---|---|---|
| `1` | Small, localized low-risk work | Less context, but mandatory triggered reviews still run |
| `2` | Default feature work | Standard context and mandatory reviews |
| `3` | High-risk, cross-module, security-sensitive work | Broadest context and specialist review readiness |

## Final Closeout

`completion-gate` is not the final chat response. After it passes, the agent
must rerun `next-step`, run the printed `task-audit-summary` command, rerun
`next-step` until it reports `DONE`, and only then deliver the final report.

Final report order:

1. Short agent-authored summary, including path mode, review verdicts, docs
   status and project-memory status.
2. Verbatim Garda final user report, including its review integrity attestation.
3. Exactly one task-bound native command after completion/task-audit PASS: ON
   uses `gate human-commit --task-id "<task-id>" --message "<message>"`; OFF
   uses `gate human-commit --task-id "<task-id>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp of the answer>" --message "<message>"`.
   Print "No commit required" when there are no committable changes.
4. Only under OFF or missing authority, ask
   `Do you want me to commit now? (yes/no)` after that command. Commit only
   after a fresh yes. Authenticated ON runs this command without asking.

## Adding Specialist Skills

After init, ask your agent:

- `Show which baseline skills are already available`
- `Suggest optional packs for this task`
- `Add the java-spring pack`
- `Add the docs-process pack`

For built-in packs, the agent should use `garda skills list` and
`garda skills suggest` first, then install only the selected optional packs.
For custom project-specific skills, the agent uses
`live/skills/skill-builder/SKILL.md` to create specialist skill files
(`skill.json` + `SKILL.md`), wire triggers, and enable capabilities.
