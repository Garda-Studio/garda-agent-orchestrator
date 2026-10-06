# Findings-Only Review Contracts and Legacy Migration

This guide describes the review-result contract used by new Garda task cycles,
the artifacts derived from it, and the supported migration path for older
profiles and review history. Use `garda next-step <task-id>` as the navigator;
the examples below explain the contract but do not replace its task-specific
commands.

## Contract Surfaces

| Surface | Canonical location | Purpose |
|---|---|---|
| Shipped JSON Schema | `template/schemas/review-findings-report.schema.json` | Package/source contract for a reviewer result. |
| Installed JSON Schema | `garda-agent-orchestrator/live/schemas/review-findings-report.schema.json` | Materialized copy used by the workspace. |
| Human contract | `garda-agent-orchestrator/live/docs/reviews/TEMPLATE.md` | Explains the generated findings-only handoff. |
| Generated reviewer files | `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-{role-prompt,prompt-template,output-template,evidence-manifest}.*` | Immutable, task- and cycle-bound reviewer instructions. |
| Reviewer scratch output | Exact `ReviewOutputPath` printed by `prepare-reviewer-launch` | The reviewer's only permitted write. |

The shipped and installed schemas are Garda-managed. Materialization refreshes
the canonical filename but preserves unrelated user-owned files under
`live/schemas/`.

## Reviewer Output

A reviewer in a new cycle returns exactly one JSON object. It reports evidence
and findings only; it does not decide the verdict, disposition, remediation,
follow-up, profile, or downstream task state. The generated output template is
the authoritative fill-in form for the cycle.

The following is a schema-valid empty-findings example. Its hashes and coverage
obligations are illustrative and must be replaced with the exact values from
the generated handoff; copying this example into a real cycle will fail its
binding and complete-coverage checks.

```json
{
  "schema_version": 1,
  "task_id": "T-001",
  "review_type": "code",
  "review_context_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "tree_state_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "validation_notes": [
    {
      "id": "N-001",
      "topic": "complete-scope-sweep",
      "note": "Reviewed the changed behavior and its focused regression.",
      "evidence": [
        {
          "location": "src/example.ts:10",
          "observation": "The changed branch preserves the documented boundary."
        }
      ]
    }
  ],
  "coverage_ledger": {
    "coverage_contract_sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "entries": [
      {
        "obligation_id": "FILE-001",
        "evidence": [
          {
            "location": "src/example.ts:10",
            "observation": "The changed file was reviewed."
          }
        ],
        "finding_ids": []
      }
    ]
  },
  "findings": {
    "critical": [],
    "high": [],
    "medium": [],
    "low": []
  },
  "residual_risks": [],
  "reviewer_notes": []
}
```

Deterministic ingestion checks all of the following before accepting the
result:

- the JSON Schema and exact top-level fields;
- task id, review type, review-context hash, and tree-state hash bindings;
- every generated coverage obligation exactly once with concrete changed-file
  `path:line` evidence;
- bidirectional links between each active `F-NNN` finding and its coverage
  obligations;
- reviewer identity, launch input, routing, and current-cycle receipt bindings;
- absence of reviewer-authored verdict, status, disposition, remediation, and
  follow-up fields.

An empty findings object is findings-satisfied only after these checks pass.
Malformed output is not a finding and does not become pass evidence.

### Focused command evidence

Task timeline history retains immutable review and restart evidence within a
finite 1,000,000 structural-token budget. Existing container, depth, record,
line and snapshot byte limits continue to apply. Increasing this bounded
capacity does not permit rewriting history or reusing stale review receipts.

A focused self-validation attempt must name exactly one concrete repository
target. A quoted `--test-name-pattern` may contain literal regex alternation,
for example `node --test --test-name-pattern "parser|schema" tests/parser.test.js`.
ASCII double quotes are supported, including `--test-name-pattern="parser|schema"`.
Single quoting is rejected without an execution-shell binding because CMD treats
apostrophes as ordinary characters and may interpret enclosed operators.
The original attempted command remains unchanged in the review evidence.
The command field is validated and returned without trimming. Admissible ASCII
spaces and tabs at either edge remain part of the attempted evidence; forbidden
whitespace and controls are rejected at the edges as well as inside the command.
For runtimes and direct validators, `--` ends option parsing: subsequent arguments
are positional and cannot supply a validation option or hide additional targets.
Recognized package managers permit one argument-forwarding delimiter; the next
actual `--` ends the forwarded runner's option parsing. Following selector and
scalar flags remain positional and cannot hide additional input files. A consumed
selector value of `"--"` neither uses the forwarding allowance nor terminates
option parsing.
Argument spelling and empty arguments remain intact until their roles are known:
`./` cannot disappear as a positional directory, and `./--test` cannot become a
runtime option. Path normalization applies only to path checks and comparisons.
Known literal selector values remain regex data, including a leading escaped dot;
separate-value and `=` forms have the same admission behavior. Reconstructed path
restrictions still apply to programs, positional inputs and non-selector option
values, including consumed configuration paths.
Inline selector roles apply only before the actual option terminator; unknown
options and post-terminator arguments cannot gain that exemption. Local validator
program paths accept both `/` and ordinary Windows `\` separators by normalizing
a program-path copy while retaining the command and selector spelling.
Node's built-in validation mode requires an actual `--test` or `--check` option
before the program target and option terminator. Selectors such as
`--test-name-pattern` and `--test-only` do not establish that mode; consumed
selector values and arguments after an ordinary script name cannot supply it.
For Node's built-in test/check modes, the first file operand ends option roles:
later selector or scalar tokens remain positional and cannot conceal more files
or retain literal-selector path exemptions. Program and positional boundaries
come from the same argument-role parse used for runner and target accounting.
Recognized local validation scripts retain their existing admission rules.
Without a built-in Node mode, recognized validator scripts retain their own
selector arguments; Python module validators retain their runner arguments.
A runtime terminator does not hide its following program: local validator
programs and the known Node test wrapper remain distinct from their one concrete
input. A wrapper command must occupy its actual first program-argument position.
Python module validation requires a real `-m` option before the program and
terminator, followed by a recognized validator module. Other runtimes, consumed
selector values and ordinary script arguments cannot supply Python module mode.
Reconstructed command tokens must also remain repository-relative: leading
slashes, drive prefixes and `..` path segments are prohibited even when split
across quoted fragments, including in the validator script path.

Pipes, command chaining and background operators outside quotes remain
prohibited. Line breaks, substitutions, expansions, network access, mutation
flags and output-file options remain prohibited even when a selector is
quoted. Typographic quotes, unterminated quotes and backslash-escaped quotes are rejected because
their boundaries cannot be interpreted consistently across supported shells.
Special and positional dollar parameters, Unicode variable names and
shell-prefixed quote forms are also rejected. Literal regex end anchors inside
ordinary ASCII quotes remain supported.
History and delayed expansion markers (`!`) are conservatively rejected inside
and outside quotes; unquoted `!(...)` remains prohibited.
Unquoted wildcard and grouping syntax is rejected, including prefixes or suffixes
attached to quoted selector fragments. Literal regex wildcards and parentheses
inside ordinary ASCII quotes remain supported.
Unquoted backslash-escaped whitespace or dots, tilde prefixes (including `~user`, `~+` and `~-`),
comment/splatting markers and whitespace other than ASCII space or tab are
rejected because they can change shell argument boundaries or values. Ordinary
Windows path separators remain supported, except before an unquoted dot: POSIX
shells can interpret that escape as part of a parent traversal hidden by Windows
path normalization. Escaped regex dots inside double quotes remain supported.
Percent expansion guards include CMD substring/replacement syntax, complex or
Unicode environment names and positional/batch forms. Shell control characters,
including NUL, are rejected inside and outside quotes. A single percent sign
without an expansion prefix remains a supported literal selector character.

## Derived Artifacts and Policy

`record-review-result` preserves the exact reviewer output and derives the
remaining state under orchestrator ownership:

| Artifact | Meaning |
|---|---|
| `<task-id>-<review-type>-review-output.md` | Exact persisted reviewer JSON. |
| `<task-id>-<review-type>-findings-validation.json` | Deterministic validation result and hashes. |
| `<task-id>-<review-type>-findings-disposition.json` | Locked profile-policy action for every accepted finding or residual risk. |
| `<task-id>-<review-type>-receipt.json` | Authenticated references to launch, output, validation, and disposition evidence. |
| `<task-id>-<review-type>-findings-follow-ups.json` | Idempotent follow-up materialization evidence when required. |

The active profile's `review_finding_policy` and
`review_follow_up_policy` are copied into the task profile-policy snapshot at
task entry. Later profile changes affect future tasks only. A current receipt
is accepted only when its validation and disposition artifacts still match
their recorded paths, hashes, result hashes, task cycle, and review tree.

Built-in finding actions are:

- `soft`: fix critical; create follow-ups for high; ignore medium, low, and
  residual risks;
- `balanced`: fix critical, high, and medium; create follow-ups for low and
  residual risks;
- `strict`: fix every finding and residual risk in the current task.

`fix_now` items keep the lane findings-unsatisfied. `create_follow_up` items are
materialized only from accepted validation/disposition evidence. With
`grouped_by_parent`, Garda waits for all required lanes and creates one pending
F-task for the parent; with `per_finding`, it creates one F-task per item.
Repeated materialization is idempotent, and warning text never creates work.

Use the path and command printed by `next-step`. A representative explicit
ingestion command is:

```bash
garda gate record-review-result \
  --task-id "T-001" \
  --review-type "code" \
  --preflight-path "garda-agent-orchestrator/runtime/reviews/T-001-preflight.json" \
  --review-output-path "garda-agent-orchestrator/runtime/tmp/reviews/T-001/code/review-output.md" \
  --reviewer-execution-mode "delegated_subagent" \
  --reviewer-identity "agent:<provider-reviewer-id>" \
  --repo-root "."
```

When a validated disposition requires follow-up materialization, the explicit
gate form is:

```bash
garda gate materialize-review-follow-up-tasks \
  --task-id "T-001" \
  --review-type "code" \
  --disposition-artifact-path "garda-agent-orchestrator/runtime/reviews/T-001-code-findings-disposition.json" \
  --repo-root "."
```

## Selective Remediation and Recovery

For DELTA remediation, new baselines preserve `origin_coverage_contract`, bound
to the accepted findings-validation coverage hash. Lane-local `FILE-NNN` ids
are resolved from that contract, never from task-wide file ordering. The
reviewer's required targets include the actual changed files plus the original
targets of blocking findings, all within the authenticated task scope. Thus a
test-only fix can recheck its source-linked finding without pretending the
source changed. The reviewer must cover every assigned target and explicitly
inspect each resolvable prior finding.

The actual content diff still determines remediation category and affected
review lanes. Mandatory reinspection does not invalidate independent lanes;
the frozen dependency graph still controls downstream invalidation. When an
original file mapping cannot be resolved safely, including legacy baselines
without that mapping, Garda selects FULL before rerun setup rather than failing
while building a DELTA context.

After a `fix_now` finding, change only the required implementation/test scope
and rerun `garda next-step <task-id>`. When recovery is eligible, the navigator
prints one `restart-review-cycle` command. Its impact analysis classifies the
remediation as `test_coverage_only`, `test_hook_isolation`, `api_surface`,
`runtime_behavior`, `security_sensitive`, `refactor_structure`, or fail-closed
`unknown`.

The remediation baseline binds the prior validation/disposition inventory,
receipt, tree state, and changed-file groups. Garda may preserve a prior
findings-satisfied lane only when its authenticated scope remains valid;
affected or ambiguous lanes receive fresh contexts and fresh delegated
reviewers in dependency order.

Representative command shape:

```bash
garda gate restart-review-cycle \
  --task-id "T-001" \
  --task-intent "Fix the accepted code-review finding" \
  --changed-file "src/example.ts" \
  --impact-analysis "Changed the reported branch only; related tests remain in scope; no unrelated blocker or follow-up decision changed." \
  --repo-root "."
```

Do not edit receipts, validation/disposition artifacts, launch metadata,
task-event journals, or remediation baselines manually. If a hash or binding is
stale, rerun `next-step` and use its recovery command. This preserves valid
lane evidence without silently accepting stale output.

## Legacy Migration

Legacy data remains readable, but it never becomes current evidence merely
because it can be parsed.

| Legacy state | Runtime behavior and diagnostic | Supported operator action |
|---|---|---|
| Profile missing `review_finding_policy` | Resolves fail-closed to `strict` and reports `missing review_finding_policy; resolved fail-closed to strict`. | Preview and apply an explicit policy with the guarded CLI below. |
| Profile missing `review_follow_up_policy` | Defaults compatibly to `per_finding` and reports `missing review_follow_up_policy; defaulted compatibly to per_finding`. | Add the explicit validated policy block for future tasks, then run `garda profile validate`. There is no automatic conversion to grouped mode. |
| Existing task snapshot missing either policy | Uses its recorded compatibility fallback and emits snapshot diagnostics. | Do not rewrite the active snapshot. Finish it under the locked fallback; migrated profiles apply to newly entered tasks. |
| Heading-based Markdown or PASS/FAIL verdict artifact | Readable as historical audit data only; rejected for a current findings-only context. | Preserve it, rerun `next-step`, and launch the one fresh reviewer requested for the current generated context. |
| Tampered/missing validation, disposition, receipt, or launch binding | Fails closed with the mismatched path/hash/binding in diagnostics. | Preserve evidence and follow the single recovery command from `next-step`; never reconstruct or hand-edit proof. |

To make a legacy finding policy explicit, first preview the intended preset:

```bash
garda profile policy preview <profile-name> --preset balanced --json
```

Then apply the same candidate with all three hashes from that preview and fresh
operator confirmation:

```bash
garda profile policy apply <profile-name> --preset balanced \
  --expected-policy-sha256 "<policy_sha256>" \
  --expected-plan-sha256 "<plan_sha256>" \
  --expected-config-sha256 "<before_config_sha256>" \
  --operator-confirmed yes \
  --operator-confirmed-at-utc "<ISO-8601 timestamp>"
```

To opt a legacy profile into grouped follow-ups for future tasks, add this
validated profile field through the repository's normal configuration-change
workflow and validate the complete profile file:

```json
{
  "review_follow_up_policy": {
    "schema_version": 1,
    "materialization_mode": "grouped_by_parent"
  }
}
```

```bash
garda profile validate
```

This is an explicit configuration migration, not an `update`/`init`
auto-migration. Existing task snapshots keep their original policy and hashes.

## Existing Identity and Timing Diagnostics

Findings validation does not add a provider adapter, launch another reviewer,
or replace launch/timing checks. The existing delegated-review launch records
the provider-owned `agent:` identity and invocation evidence; the accepted
receipt binds that launch to the result. `garda gate task-audit-summary` reports
attempt counts and review timing from those existing artifacts. A timing
warning is advisory and cannot create a finding, follow-up, provider action, or
extra review by itself.

For any blocked state, run:

```bash
garda next-step T-001
```

Use only its single command. Do not recover by adding a verdict to findings
JSON, copying an older receipt, inventing a provider action, or launching an
extra reviewer outside the current dependency graph.
