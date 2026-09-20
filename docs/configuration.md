# Configuration

All configuration files live in `garda-agent-orchestrator/live/config/`.

## Compact command controls

The **Compact** UI group edits `workflow-config.json` through the existing confirmed, audited settings route. It shows observed cache bytes/runs and provides enable/disable controls for compact itself and the shipped Git, file and ripgrep adapters. Disabling a family prevents its producer from running. Retained output remains readable until task completion.

The optional `compact` section defaults to:

```json
{
  "enabled": true, "git": true, "file": true, "rg": true,
  "preview_lines": 20, "preview_chars": 3000,
  "run_bytes": 16777216, "task_bytes": 67108864,
  "workspace_bytes": 268435456, "max_runs": 2048
}
```

CLI settings use `workflow set --compact-enabled false`, `--compact-git false`, `--compact-file false`, `--compact-rg false`, `--compact-preview-lines`, `--compact-preview-chars`, `--compact-run-bytes`, `--compact-task-bytes`, `--compact-workspace-bytes` and `--compact-max-runs`, with the normal operator confirmation arguments. Limits can be reduced, not raised above these ceilings; run ≤ task ≤ workspace, at least 9216 bytes, preview at least 3 lines/128 characters. When lowering hierarchical limits in the UI, lower the inner limit first. No secret-redaction option exists. New command adapters are a code extension, not arbitrary UI commands.

The root manifest `garda.config.json` references the managed config files validated by the orchestrator and can be checked with:

```bash
node bin/garda.js gate validate-config
```

## Config Files Overview

| File | Purpose | Editable? |
|---|---|---|
| `garda.config.json` | Root config manifest referencing the 11 managed config files validated by `validate-config` | No, maintained by orchestrator |
| `token-economy.json` | Reviewer-context compaction and token savings | Yes |
| `output-filters.json` | Gate output compaction profiles (compile, test, lint, review) | Yes |
| `review-capabilities.json` | Which specialist reviews are enabled | Yes |
| `review-catalog.json` | Optional custom review-lane declarations; absence keeps built-in compatibility | Yes, through guarded `garda review-catalog ...` commands |
| `paths.json` | Preflight classification roots and trigger regexes | Yes |
| `skill-packs.json` | Installed built-in domain packs | Yes, through `garda skills add/remove` |
| `optional-skill-selection-policy.json` | Repo-local policy for preprompt-time optional skill selection (`off`, `optional`, `mandatory`; legacy aliases remain read-compatible) | Yes |
| `isolation-mode.json` | Control-plane isolation and sandbox settings | Yes |
| `profiles.json` | Active profile selection plus built-in and user profile definitions | Yes, through `garda profile ...` |
| `review-artifact-storage.json` | Review artifact retention and storage policy | Yes, through `garda cleanup policy ...` |
| `runtime-retention.json` | Tiered runtime-retention policy for active evidence, healthy `DONE` ledger compaction, problem-task compression, confirm-only purge, and daily maintenance | Yes, through template/config review for now; `garda cleanup policy` shows it read-only |
| `workflow-config.json` | Compile-gate, full-suite, optional-check, and workflow command settings | Yes, through `garda workflow ...` and guarded UI settings |
| `skills-index.json` | Compact optional-skill discovery index; generated runtime index and not part of `garda.config.json` | No, generated from pack manifests |
| `skills-headlines.json` | Compact task-start optional-skill selection surface with installed skill headlines and pack summaries | No, generated from live skill/pack manifests |

`garda.config.json` is rewritten from the bundled template during init/reinit/update, so stale local edits do not become the long-term source of truth.
The editable live configs above are merged forward during init/reinit/update: existing live values are preserved and ordinary missing template keys are filled in. The guarded `profiles.json` remediation-mode policy is the exception: omission is preserved for an existing profile so a legacy workspace cannot acquire DELTA behavior without explicit migration.

## Validation

### CLI Gate

```bash
# Full output
node bin/garda.js gate validate-config --bundle-root garda-agent-orchestrator

# Compact (CI-friendly)
node bin/garda.js gate validate-config --compact
```

Validates the managed config files referenced by `garda.config.json` against portable JSON Schemas and runtime validators.
Exits non-zero on validation failure.

### CI Script

```bash
node scripts/validate-config.cjs
```

### JSON Schemas

Portable JSON Schema definitions (draft-07) are available for each managed config file
in `src/schemas/config-schemas.ts`. Each schema can be serialized to a `.json`
file for use with external validators, IDE autocomplete, or CI linters.

## Token Economy

Controls reviewer-context compaction and determines how aggressively context is trimmed at different task depths.

**File:** `live/config/token-economy.json`

```json
{
  "enabled": true,
  "enabled_depths": [1, 2],
  "strip_examples": true,
  "strip_code_blocks": true,
  "scoped_diffs": true,
  "compact_reviewer_output": true,
  "fail_tail_lines": 50
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master toggle for reviewer-context token economy |
| `enabled_depths` | `[1, 2]` | Depths at which context compaction applies |
| `strip_examples` | `true` | Remove verbose examples from rule context |
| `strip_code_blocks` | `true` | Compress code-block sections in rules |
| `scoped_diffs` | `true` | Use scoped diff instead of full diff |
| `compact_reviewer_output` | `true` | Apply output-filter profiles to gate output |
| `fail_tail_lines` | `50` | Max lines of compile failure output |

### Depth Behavior

| Depth | Context Scope | Token Economy | Typical Use |
|---|---|---|---|
| `1` | Minimal (core + workflow + touched module) | Full compaction | Small, low-risk, localized tasks |
| `2` | Standard (most rule files + module context) | Full compaction | Default for most tasks |
| `3` | Complete (all rules + cross-module checks) | Gate filtering only | High-risk, cross-cutting changes |

### What Stays Active Regardless of Token Economy

Shared gate output filtering (`output-filters.json`) and `fail_tail_lines` remain active even when `enabled=false` or at `depth=3`. These are independent of reviewer-context scope.

## Output Filters

Controls how gate scripts compress their stdout/stderr output before returning to the agent.

**File:** `live/config/output-filters.json`

Contains profiles for:
- **Compile success/failure** — per build tool (npm, gradle, maven, dotnet, cargo, go, tsc, generic)
- **Test success/failure** — generic test runner patterns
- **Lint success/failure** — generic lint patterns
- **Review gate success/failure** — gate verdict formatting

### Key Mechanisms

| Mechanism | Description |
|---|---|
| `drop_lines_matching` | Regex patterns; matching lines are removed |
| `keep_lines_matching` | Regex patterns; only matching lines are kept |
| `strip_ansi` | Remove ANSI color/control codes |
| `truncate_line_length` | Max characters per line (default: 240) |
| `parser.max_matches` | Max error/warning matches to keep |
| `parser.tail` | Lines from end of output to always include |
| `passthrough_ceiling` | Below this line count, output passes through unfiltered |

Success profiles typically use `drop_lines_matching: ".*"` to drop 100% of output on green builds.

## Runtime Retention

Controls how Garda-owned runtime artifacts are classified for cleanup and GC.

**File:** `live/config/runtime-retention.json`

```json
{
  "version": 1,
  "active_tasks": {
    "protect_runtime_grace_days": 7,
    "protect_current_cycle_artifacts": true
  },
  "healthy_done": {
    "compact_after_days": 30,
    "require_ledger": true,
    "retain_task_events_until_ledger_verified": true
  },
  "problem_tasks": {
    "compress_after_days": 30,
    "preserve_detailed_evidence": true
  },
  "purge": {
    "require_confirm": true
  },
  "daily_maintenance": {
    "enabled": true,
    "max_tasks_per_run": 25,
    "dry_run": true
  }
}
```

| Tier | Meaning |
|---|---|
| `active_evidence` | Current or protected task artifacts stay readable. |
| `compact_ledger_candidate` | Healthy `DONE` task artifacts may compact to `runtime/task-ledger/<task-id>.json` history only after verified ledger evidence exists. |
| `compressed_forensic_candidate` | Blocked, failed, incomplete, tampered, or ambiguous tasks keep recovery-readable evidence; only heavy forensic artifacts are compression candidates. |
| confirm-only purge | Full deletion requires an explicit confirmed cleanup/GC action; purge is not automatic. |

Clean-success compile and full-suite raw output logs may be intentionally omitted by the gates. Retained evidence still records status, duration, hashes, and line/char counts; warning, failure, timeout, and non-clean runs retain raw output.

## Review Capabilities

Controls which specialist reviews are enabled for the project.

**File:** `live/config/review-capabilities.json`

```json
{
  "code": true,
  "db": true,
  "security": true,
  "refactor": true,
  "api": true,
  "test": true,
  "performance": true,
  "infra": true,
  "dependency": true
}
```

Each top-level key toggles whether that review type may be required by preflight in this workspace.

Manage supported optional capability toggles through the CLI:
- `garda review-capabilities`
- `garda review-capabilities list`
- `garda review-capabilities enable <api|test|performance|infra|dependency>`
- `garda review-capabilities disable <api|test|performance|infra|dependency>`

The CLI validates that a matching live review skill is installed before enabling a supported optional capability. Bridge presence is surfaced separately for bridge-hosted providers, but root-entrypoint providers execute the live skill directly.

`skills-index.json` is still a generated runtime index under `live/config/`, but it is **not** part of `garda.config.json` and is **not** validated by `gate validate-config`.

## Review Catalog

The review catalog extends the compatibility-owned built-in review lanes with repo-local declarative lanes.

**Optional file:** `live/config/review-catalog.json`

```json
{
  "version": 1,
  "custom_review_types": [
    {
      "id": "architecture",
      "display_label": "Architecture review",
      "enabled_by_default": false,
      "skill_id": "architecture-review",
      "trigger": {
        "mode": "signals",
        "signal_ids": ["architecture"]
      },
      "coverage_category_ids": ["maintainability"],
      "reviewer_role": {
        "role_id": "architecture-reviewer",
        "focus_tags": ["maintainability"]
      }
    }
  ]
}
```

Built-in lanes remain defined by Garda compatibility contracts and retain their canonical pass/fail tokens. Custom IDs are stable lowercase kebab-case identifiers; Garda derives their canonical verdict tokens and rejects prompt bodies, verdict overrides, built-in replacements, unknown metadata, and `enabled_by_default: true`. A custom lane becomes eligible only after its skill is installed, its capability is enabled, and the selected profile assigns it `auto` or `required`.

Triggers use either `manual` mode or validated `signals`. The selected profile supplies lane state and its `review_dependency_graph`; preflight resolves those inputs into the immutable task catalog/policy snapshot and launch order. Existing tasks never observe later catalog, capability, profile, or dependency changes. Normal task agents use the compact `TaskStartReviewCatalog` and preflight snapshot, while reviewers receive only their generated launch input; neither should load the full catalog as routine context.

Inspection is read-only and safe for legacy workspaces:

```text
garda review-catalog list --target-root "."
garda review-catalog show architecture --profile balanced --target-root "."
garda review-catalog explain architecture --profile balanced --target-root "."
garda review-catalog validate --target-root "."
```

When the file is absent, these commands resolve the built-in compatibility catalog and validation still passes. Fresh init and reinit materialize the default `{ "version": 1, "custom_review_types": [] }` and preserve valid custom definitions. Existing legacy workspaces remain untouched until an operator explicitly runs the guarded migration:

```text
garda review-catalog migrate --target-root "."
garda review-catalog migrate --confirm --expected-state-sha256 <hash> --expected-plan-sha256 <hash> --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601> --target-root "."
garda review-catalog migrate --apply --expected-state-sha256 <hash> --expected-plan-sha256 <hash> --confirmation-receipt-sha256 <hash> --target-root "."
```

The preview proves that the normalized explicit catalog/profile/capability configuration preserves required reviews, verdict and receipt tokens, dependency order, task-report review lanes, and the configured or implicit review-execution preset. Migration retains the legacy capability source, preserves explicit capability choices, and leaves custom lanes disabled. Confirmation and apply bind both managed config and workflow policy state; invalid or stale input fails before writes, interrupted multi-file publication rolls back from the transaction backup, and a repeated normalized migration is an auditable `NO_CHANGE`.

Mutation commands are `create`, `update`, `enable`, `disable`, `profile-bind`, and `dependency`. They never write immediately: the first call returns a semantic preview plus current-state and plan hashes; `--confirm` with fresh operator confirmation creates a one-time receipt; `--apply` consumes that receipt and revalidates the same hashes and managed filesystem boundaries under the transaction lock. Management is rejected while agent tasks are active.

Successful changes record an audit entry and recovery backup. A failed multi-file publish automatically restores the pre-write state and records `ROLLED_BACK`; use the reported backup and audit paths for diagnosis, then run the inverse guarded mutation when recovery is needed. Do not hand-edit runtime receipts or treat a backup as an apply receipt.

Troubleshooting order:

1. Run `review-catalog validate` and `review-catalog explain <id> --profile <name>`.
2. Verify the referenced skill, capability flag, profile state, and dependency IDs.
3. If confirmation is stale, discard it and create a new preview after all active tasks finish.
4. If publish failed, inspect the rollback diagnostic and audit record; do not replay a consumed or stale receipt.

## Profile Review Finding Policy

Profiles can define how findings reported by delegated reviewers are handled independently from which review lanes run.

**File:** `live/config/profiles.json`

```json
{
  "review_finding_policy": {
    "schema_version": 1,
    "policy_id": "balanced",
    "findings": {
      "critical": "fix_now",
      "high": "fix_now",
      "medium": "fix_now",
      "low": "create_follow_up"
    },
    "residual_risk": "create_follow_up"
  }
}
```

| Field | Values | Description |
|---|---|---|
| `policy_id` | `soft`, `balanced`, `strict`, `custom` | Named disposition preset, or `custom` for explicit per-severity behavior. |
| `findings.critical` | `fix_now` | Critical findings are always fixed in the current task. The resolver and schemas reject or normalize weaker critical actions. |
| `findings.high`, `findings.medium`, `findings.low` | `fix_now`, `create_follow_up`, `ignore` | Disposition for each non-critical reviewer finding severity. |
| `residual_risk` | `fix_now`, `create_follow_up`, `ignore` | Disposition for reviewer residual-risk entries. |

Built-in presets:

- `soft`: critical findings are fixed now; high findings create follow-up work; medium, low, and residual-risk entries are ignored.
- `balanced`: critical, high, and medium findings are fixed now; low and residual-risk entries create follow-up work.
- `strict`: every finding severity and residual-risk entry is fixed now.

For backward compatibility, legacy profiles without `review_finding_policy` remain loadable. At runtime they resolve fail-closed to the `strict` preset and emit diagnostics so the missing field is visible in profile output and task evidence.

Use the guarded profile-policy CLI instead of editing the policy object directly. Preview normalizes the candidate through the same `profiles.json` schema used by persistence and returns the normalized policy hash, the contextual plan hash, and the current config hash. `policy_sha256` identifies only the normalized policy content; `plan_sha256` binds the target profile, operation, source profile, normalized policy, and proposed config hash so the plan cannot be replayed against another profile:

```bash
garda profile policy preview balanced --preset strict --json
```

Apply must repeat the same policy input, bind it to all three preview hashes, and carry fresh operator confirmation:

```bash
garda profile policy apply balanced --preset strict \
  --expected-policy-sha256 "<policy_sha256-from-preview>" \
  --expected-plan-sha256 "<plan_sha256-from-preview>" \
  --expected-config-sha256 "<before_config_sha256-from-preview>" \
  --operator-confirmed yes \
  --operator-confirmed-at-utc "<ISO-8601 timestamp>"
```

Use `--copy-from <profile>` to copy the source profile's effective policy or `--reset` to restore a built-in profile from the shipped definition. User-profile reset deterministically uses the shipped `balanced` policy and fails closed when that shipped baseline is unavailable. A legacy profile preview reports the fail-closed migration, and applying the unchanged preview materializes the explicit `strict` policy. Apply serializes all profile-config writers and rechecks the preview hash while holding the write lock. Changed mutations use an fsynced write-ahead audit transaction (`PREPARED` followed by `COMMITTED` or `ABORTED`); every CLI or UI profile writer removes a dead-owner lock and recovers an interrupted transaction from the current config hash before computing its mutation. Bounded hash-only evidence in `runtime/profile-finding-policy-audit.jsonl` stores the active-task count and full-list SHA-256 without raw task identifiers, distinguishes discovery failure from a verified empty result, and affects future task snapshots only; already-entered tasks retain their locked profile policy.

For `--preset custom`, provide all five actions: `--critical fix_now`, `--high <action>`, `--medium <action>`, `--low <action>`, and `--residual-risk <action>`. Profile writers wait for a short bounded lock window before reporting contention, while active-task discovery is performed outside the serialized config-write section. Interactive profile creation also rejects a commit if `profiles.json` changed while prompts were open, preventing inheritance from a stale source snapshot.

## Profile Remediation Review Mode Policy

New shipped profiles declare an explicit conservative policy:

```json
{
  "review_remediation_mode_policy": {
    "schema_version": 2,
    "policy_id": "conservative_review_remediation_mode_v1",
    "initial_review_mode": "FULL",
    "delta_eligible_review_types": ["api", "code", "db", "dependency", "infra", "performance", "refactor", "security", "test"],
    "force_full_categories": ["ambiguous", "generated_churn", "global"],
    "max_delta_changed_files": 4,
    "max_delta_changed_lines": 240,
    "max_consecutive_delta_reviews": 3
  }
}
```

Schema 2 enables every review lane present in the current catalog for bounded DELTA remediation when a profile
is created or a schema-1 policy is migrated. Custom lanes use their stable lowercase kebab-case ID and must be
registered in `review-catalog.json`.
Profile validation and effective-policy resolution reject syntactically valid but unregistered lane IDs. Remove a lane from `delta_eligible_review_types`
to force only that lane to FULL; an empty array disables DELTA for every lane. Existing schema-2 allowlists are
preserved so explicit removals remain stable. Valid schema-1 policies are upgraded
once during init. An unresolved schema-1 policy and a profile with no policy both keep legacy FULL-only behavior.

The first review for every lane remains `FULL`. Eligible remediation may use
`DELTA` only while the immutable task snapshot, exhaustive baseline lineage,
scope membership, findings reconciliation, and bounded risk checks remain
valid. Missing policy is not defaulted during init/update of an existing
profile: it is preserved as a visible legacy `FULL`-only state. To migrate,
create a current profile or add the exact schema-valid policy explicitly before
starting the next task. Existing task snapshots never change retroactively.

Profiles also control how non-blocking `create_follow_up` items become backlog work:

```json
{
  "review_follow_up_policy": {
    "schema_version": 1,
    "materialization_mode": "grouped_by_parent"
  }
}
```

`per_finding` preserves the legacy one-child-per-item behavior. `grouped_by_parent` waits until all required review lanes finish, then creates one snapshot- and cycle-bound pending child and appends each validated deferred item with its source lane, severity, evidence, receipt, validation, disposition, and deterministic fingerprints. It never groups `fix_now` work and refuses to mutate a child that is no longer `TODO`. Legacy profiles and snapshots default compatibly to `per_finding`; changing a profile affects future task snapshots only.

See [Findings-Only Review Contracts and Legacy Migration](findings-contracts.md)
for the reviewer JSON Schema, derived evidence chain, selective remediation,
exact legacy diagnostics, and explicit migration procedure.

## Skill Packs

Tracks which built-in domain packs are currently installed in the workspace.

**File:** `live/config/skill-packs.json`

Manage it through the CLI:
- `garda skills list`
- `garda skills add <pack-id>`
- `garda skills remove <pack-id>`
- `garda skills validate`

This file is runtime state and should normally be changed through the CLI rather than by hand.

Packs are install/discovery bundles for optional specialist skills.
They are not a second copy of baseline skills; baseline skills stay available without any pack install.

## Optional Skill Selection Policy

Controls whether `preprompt` and the task-start lifecycle derive and validate a cheap optional-skill decision from `skills-headlines.json` before implementation begins.

**File:** `live/config/optional-skill-selection-policy.json`

```json
{
  "version": 1,
  "mode": "optional"
}
```

Modes:
- `off` disables task-start optional-skill selection.
- `optional` computes a read-mostly selection artifact and compact preview without blocking the task.
- `mandatory` expects a materialized, internally valid selection artifact for the current task cycle before implementation proceeds. `preprompt task` exits non-zero for that start-time blocker, and `compile-gate` or downstream review gates also refuse the current cycle when the artifact is missing or drifted.

Legacy values remain read-compatible for older workspaces: `advisory` maps to `optional`, and `required`/`strict` map to `mandatory`. Guarded saves write the canonical mode.

## Optional Quality Checks

Controls the advisory self-checklist gate that runs after implementation changes exist and before expensive validation gates.

**File:** `live/config/workflow-config.json`

```json
{
  "optional_quality_checks": {
    "enabled": true,
    "baseline_version": "2026-06-27.t846",
    "rules": [
      {
        "id": "code_simplification",
        "title": "Code simplification",
        "prompt": "Check whether the changed code can be simplified without weakening behavior, validation, or diagnostics.",
        "enabled": true
      }
    ]
  }
}
```

Contract:
- the mode is default-enabled when the setting is absent;
- the shipped baseline version records which default rule set was materialized;
- default rules cover simplification, project style fit, unnecessary abstraction, class/function/file growth, hardcoded values or contracts, duplicated logic or contracts, and test/verification scope;
- `next-step` routes the gate after implementation and before compile, delegated review, or full-suite work when a current changed-file preflight needs checklist evidence;
- `PASS` continues the normal lifecycle, while `ACTION_REQUIRED` sends the agent back to implementation before the expensive gates run;
- disabled mode skips only the quality-checklist gate and does not replace or weaken compile-gate, full-suite validation, or independent review;
- baseline rule ids, titles, prompts, and deletion are managed by the shipped baseline; users can only toggle each baseline rule's `enabled` state;
- custom rules, disabled mode, custom rule edits, and local audit metadata fields are preserved during init/update/materialization refresh;
- update/setup refreshes shipped baseline text, adds missing shipped baseline rules, removes deprecated shipped baseline rules, and preserves each baseline rule's enabled or disabled state.

Manage the toggle and rules through the audited workflow-setting path:

```bash
node bin/garda.js workflow set --optional-checks on --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
node bin/garda.js workflow set --optional-check-rule-id custom_focus --optional-check-rule-title "Custom focus" --optional-check-rule-prompt "Check the custom concern." --optional-check-rule-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
node bin/garda.js workflow set --optional-check-rule-delete custom_focus --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"
```

`garda ui --actions` exposes the same toggle and add/edit/delete controls in the workflow settings panel. The browser never writes `workflow-config.json` directly; it previews and runs the allow-listed `garda workflow set` commands with the normal typed confirmation and audit log.
Baseline rows in the UI expose only the enabled toggle; title, prompt, and delete controls are reserved for custom rules.

## Skills Index

Compact discovery metadata for optional skills.

**File:** `live/config/skills-index.json`

Used by:
- `garda skills suggest`
- the agent-init specialist-skills recommendation flow

Contract:
- this index is the discovery surface for pack suggestion and agent-init-time specialist recommendations;
- after the user selects a pack, installation should only materialize files into `live/skills/**` and must not require reading the full optional `SKILL.md`;
- full optional `SKILL.md` files must stay unopened until a selected skill is actually activated for a task or a hard activation rule requires it;
- the index is generated from pack manifests and should not be edited manually in deployed workspaces.

## Skills Headlines

Compact task-start selection metadata for already installed optional skills and available pack headlines.

**File:** `live/config/skills-headlines.json`

Used by:
- `garda preprompt task`
- task-start optional-skill selection before implementation

Contract:
- this file is the cheap surface for current-task optional-skill selection once task text and planned scope are known;
- it should be read before opening any optional `SKILL.md`;
- full optional `SKILL.md` files are opened only for skills that were actually selected for the current task;
- the file is generated from live skills and pack manifests and should not be edited manually in deployed workspaces.

## Paths Configuration

Controls preflight classification roots and regex triggers for each review type.

**File:** `live/config/paths.json`

Defines:
- **Root directories** for source code classification.
- **Trigger patterns** (regexes) that map file paths to required review types.
- **Sensitive path markers** for security, auth, payment, database, migration, and infrastructure paths.

## Compact Command Hints

Agent rules in `live/docs/agent-rules/40-commands.md` include a **Compact Command Hints** section that teaches agents to use efficient CLI flags. This reduces token consumption on everyday shell commands without any infrastructure changes.

See `template/docs/agent-rules/40-commands.md` section `## Compact Command Hints` for the full reference.
