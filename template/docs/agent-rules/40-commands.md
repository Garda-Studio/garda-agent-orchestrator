# Commands

Primary entry point: selected source-of-truth entrypoint for this workspace.

IMPORTANT: Prefer orchestrator-managed validation over ad-hoc validation.
During orchestrated task execution, run builds, tests, type-checks, and full-suite validation through the mandatory gate flow whenever possible. Use `next-step` to choose the next lifecycle command, `compile-gate` for build/type-check validation, and `full-suite-validation` for the configured full test suite.
Avoid standalone ad-hoc build, test, or lint commands outside the gate pipeline unless the prompt explicitly asks for them, a focused local debug pass is needed before mandatory gates, or a mandatory gate requires the underlying command.
For focused manual validation, prefer `gate run-intermediate-command` before direct targeted test invocations; use the bounded Manual Validation Logs pattern below only when the command is not eligible for that gate.
User preferences such as "do not run rebuild" or "skip tests" never waive mandatory gate validation. If a required gate wraps a build, test, or type-check command, run the gate and let the gate manage the command and output filtering.
Canonical gate surface is `node garda-agent-orchestrator/bin/garda.js gate <name>`.
Default task loop: run `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."` before the first gate, after every suggested command, and after any gate failure. Follow its single recommended command instead of guessing from defaults, stale artifacts, or the static gate list.

### Ad-Hoc vs Mandatory Gate Commands
Ad-hoc command restraint and mandatory gate execution are separate concerns:
- **Ad-hoc commands** (project build, test, or lint commands executed directly) - avoid as routine task validation. Use them only when requested, when doing a focused local debug pass, or when there is an explicit technical reason before returning to the gate flow.
- **Mandatory gate commands** (`node garda-agent-orchestrator/bin/garda.js gate compile-gate`, `full-suite-validation`, etc.) - always execute when required by the workflow. A gate wrapping a build/test command is not ad-hoc execution; it is lifecycle-required validation with controlled output.
- **Intermediate validation commands** (`gate run-intermediate-command`) - use for scoped, auditable manual probes while investigating one localized issue. The gate stores full raw output as an artifact and shows only compact status or a bounded failure tail in the transcript.
- **Known producer-consumer validation chains** (`npm run build:node-foundation` -> direct `node --test .node-build/...`, similar generated-artifact consumers) - do not fan these out through raw shell sidecars. Use the guarded workflow path, `npm test`, or run producer then consumer strictly sequentially.

Example (materialized/deployed workspace):
```
# x Ad-hoc - avoid as routine task validation:
<project build command>
<project test command>

# OK Mandatory gate - always execute when required:
node garda-agent-orchestrator/bin/garda.js gate compile-gate --task-id "T-042" --preflight-path "garda-agent-orchestrator/runtime/reviews/T-042-preflight.json"
# compile-gate may run a configured project build/type-check command; that is allowed because it is gate-driven, not ad-hoc.
```

### Auditable Intermediate Commands
Use `gate run-intermediate-command` for focused manual validation that is
eligible for the auditable compact wrapper. This is the preferred path before
raw targeted test, typecheck, or validation probes.

```bash
node garda-agent-orchestrator/bin/garda.js gate run-intermediate-command --task-id "<task-id>" --command-source "targeted-test" --command "<project test command> -- tests/<path>.test" --repo-root "."
node garda-agent-orchestrator/bin/garda.js gate run-intermediate-command --task-id "<task-id>" --command-source "node-test" --command "node --test tests/<path>.test.js" --repo-root "."
```

Rules:
- Use only for one scoped question or suspected concrete finding before
  returning to `next-step`.
- Keep the command targeted; do not wrap a redundant full suite in
  `run-intermediate-command`.
- The gate writes full raw output to a task-owned artifact and prints compact
  status or a bounded failure tail.
- Focused-test evidence binds the command record and raw output by task event,
  SHA-256, byte size, review chronology, changed-test scope, and in-root paths;
  default and caller-designated paths under `runtime/reviews` use the same
  integrity contract.
- When a failed reviewer report contains the sole canonical finding
  `[garda:evidence-only:missing-focused-validation] test=<changed-test-path>; action=run-and-record-focused-test`,
  run that exact changed test through this gate after recording the review,
  then return to `next-step`. Current passing evidence routes a fresh review
  cycle without source mutation; foreign, stale, failed, mismatched, or
  modified evidence remains fail-closed.
- This command never replaces `compile-gate`, `full-suite-validation`, required
  reviews, or completion evidence.
- Test-first expected-red is an explicit exception to ordinary passing focused
  validation: put the exact marker `Test-first: expected-red` in the task's
  `TASK.md` Notes, then follow the `next-step` command that adds
  `--expect-failure`. That mode accepts only a current test-only preflight and a
  concrete changed focused test. A real non-zero test exit is recorded with
  bounded output; an unexpected pass, timeout, cancellation, unrelated test,
  foreign task, stale preflight, or modified artifact fails closed. After the
  evidence is recorded, `next-step` exposes implementation and still requires
  refreshed preflight, compile, full-suite, reviews, and completion after the
  production change.
- If the command is not eligible for `run-intermediate-command`, use the Manual
  Validation Logs pattern below so chat output remains bounded and auditable.

### Manual Validation Logs
Manual validation outside the gate pipeline must keep the agent transcript bounded.
Use this pattern only for focused debug or split-repair validation before returning
to `next-step`; it does not replace `compile-gate`, `full-suite-validation`, or
any gate-owned artifact.

PowerShell:
```powershell
$taskId = "<task-id>"
$logDir = "garda-agent-orchestrator/runtime/manual-validation/$taskId"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir "npm-test.log"
& npm test *> $logPath
$exitCode = $LASTEXITCODE
"ManualValidationExitCode: $exitCode"
"ManualValidationLogPath: $logPath"
Get-Content -Path $logPath -Tail 80
exit $exitCode
```

POSIX shell:
```bash
task_id="<task-id>"
log_dir="garda-agent-orchestrator/runtime/manual-validation/$task_id"
mkdir -p "$log_dir"
log_path="$log_dir/npm-test.log"
npm test >"$log_path" 2>&1
status=$?
printf 'ManualValidationExitCode: %s\n' "$status"
printf 'ManualValidationLogPath: %s\n' "$log_path"
tail -n 80 "$log_path"
exit "$status"
```

Rules:
- Print only the exit code, full log path, and a bounded tail or summary in chat.
- Keep full stdout/stderr in the task-owned runtime log for audit.
- To attach selected logs to reviewer handoff, create
  `garda-agent-orchestrator/runtime/manual-validation/$taskId/review-evidence.json`
  with explicit `selected_logs` entries. Each entry must include `path`,
  `command`, and either `exit_code` or `status`; relative `path` values are
  resolved from `runtime/manual-validation/$taskId`; optional `review_types`
  scopes the log to specific reviewer lanes.
- Reviewer context reads only this explicit selector; it must not auto-scan
  every runtime log.
- Do not use this pattern to hide failures; preserve the original exit code.
- Do not use this pattern for mandatory lifecycle gates, which already own output
  filtering and evidence materialization.

### Manual Validation Evidence Selector

The selector must contain a root `task_id` matching the current task and its
`runtime/manual-validation/<task-id>` directory, alongside `selected_logs`.
Missing or foreign task identity is rejected. Manual logs are untrusted,
supplemental evidence; they never replace mandatory gates or review receipts.

Minimal valid shape for `runtime/manual-validation/T-042/review-evidence.json`:

```json
{
  "task_id": "T-042",
  "selected_logs": [
    {
      "path": "node-version.log",
      "command": "node --version",
      "exit_code": 0
    }
  ]
}
```

This example attaches a real, already-run version probe. Replace the task ID,
log path, command and outcome with the actual completed check; do not invent a
successful result or use the example probe instead of relevant validation.
Relative log paths resolve inside the task's manual-validation directory.
An entry may use `status` instead of `exit_code` and may set `review_types` to
specific lanes. Keep failure diagnostics and the original outcome.

## Project Commands (Required)
Replace these defaults with repository-specific commands when the real project differs.

### Setup
```bash
npm install --prefer-offline --no-fund --no-audit
node garda-agent-orchestrator/bin/garda.js setup --target-root "."
```

### Run
```bash
node garda-agent-orchestrator/bin/garda.js status --target-root "."
node garda-agent-orchestrator/bin/garda.js agent-init --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "AGENTS.md, CLAUDE.md, GEMINI.md, QWEN.md, .github/copilot-instructions.md, .windsurf/rules/rules.md, .junie/guidelines.md, .antigravity/rules.md" --project-rules-updated yes --skills-prompted yes
node garda-agent-orchestrator/bin/garda.js doctor --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
node garda-agent-orchestrator/bin/garda.js --help
```

### Skill Packs
```bash
node garda-agent-orchestrator/bin/garda.js skills list --target-root "."
node garda-agent-orchestrator/bin/garda.js skills suggest --target-root "."
node garda-agent-orchestrator/bin/garda.js skills add node-backend --target-root "."
node garda-agent-orchestrator/bin/garda.js skills validate --target-root "."
```

### Test
```bash
<project test command from garda-agent-orchestrator/live/project-discovery.md or workflow-config>
<focused project test command>
```

Rules:
- Use the command detected in `garda-agent-orchestrator/live/project-discovery.md` or explicitly configured in `garda-agent-orchestrator/live/config/workflow-config.json`.
- If no deterministic command is detected, keep full-suite validation unconfigured until the operator sets a project-specific command.
- Test commands from this section must not be copied into `### Compile Gate (Mandatory)`; compile-gate is for compile/build/type-check only.
- Direct generated-artifact test consumers are producer-consumer flows: refresh the generated artifacts first with the owning producer command, then run the consumer.
- Do not launch the producer and direct generated-artifact consumer as parallel raw shell commands; that bypasses the guarded validation-chain path.

### Quality
```bash
<project type-check command>
<project validation command>
```

### Compile Gate (Mandatory)
```bash
__COMPILE_GATE_COMMAND_UNCONFIGURED__
```

Rules:
- `garda-agent-orchestrator/live/config/workflow-config.json` `compile_gate.command` is the executable compile-gate command.
- This markdown block is a human-visible project hint only; compile-gate does not use it as a fallback when workflow config is unconfigured.
- `__COMPILE_GATE_COMMAND_UNCONFIGURED__` is a blocking sentinel. Replace it during init/agent-init with a project-specific compile/build/type-check command or set `compile_gate.command` with `workflow set`.
- Command must be non-interactive, must return non-zero exit code on compile failure, and must be a compile/build/type-check command.
- Do not use full-suite test commands here (`npm test`, `mvn test`, `gradle test`, `go test`, `cargo test`, `dotnet test`, `pytest`, or equivalent). Put full repository tests in `full-suite-validation` instead.
- Preferred examples: Node/TypeScript `npm run build` or `npx tsc --noEmit`; Maven `./mvnw compile`; Gradle `./gradlew assemble`; Go `go build ./...`; Rust `cargo check`; .NET `dotnet build`.
- If the repository truly has no separate compile/build/type-check command, stop for operator approval before using the compile-gate override flags.
- This command is executed by `node garda-agent-orchestrator/bin/garda.js gate compile-gate` before review phase.

### Optional Quality Checks
```bash
node garda-agent-orchestrator/bin/garda.js workflow set --optional-checks-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --target-root "."
node garda-agent-orchestrator/bin/garda.js workflow set --optional-check-rule-id custom_focus --optional-check-rule-title "Custom focus" --optional-check-rule-prompt "Check the custom concern." --optional-check-rule-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --target-root "."
node garda-agent-orchestrator/bin/garda.js workflow set --optional-check-rule-delete custom_focus --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --target-root "."
```

Rules:
- Optional quality checks are advisory self-check rules that `next-step` routes after implementation changes and before compile/review/full-suite work when current checklist evidence is missing.
- Default rules cover simplification, project style fit, unnecessary abstraction, growth, hardcoded values or contracts, duplication, and verification scope.
- When `next-step` materializes an answers template, fill every active `status` and `answer` (plus any rule-specific required fields), then rerun `next-step`. The executable `quality-checklist` command is printed only after those answers are complete and valid; never run a blank scaffold as evidence.
- `ACTION_REQUIRED` means return to implementation/refactor work and address the listed follow-up before continuing to expensive gates.
- Disabling the mode skips only `quality-checklist`; it does not replace or weaken compile-gate, full-suite validation, or independent review.
- Rule edits must go through the audited workflow-setting path or the guarded local UI settings controls, not direct JSON edits.

### Build and Package
```bash
npm run build
npm pack
npm publish
```

## Compact Command Policy

When available and enabled, prefer `garda compact` for noisy supported Git status/scoped diff, file ranges and repository search. Use the actual local CLI prefix printed by next-step (`node bin/garda.js compact` in source checkouts). Discover syntax via `compact --help` or `compact file|read|search --help`. Small output stays inline; explicit file ranges use a separate sequential reading budget. After localization, read a sufficient range directly instead of repeatedly searching or fetching tiny pieces. Retained reads default to 4 KiB (configurable), support `--max-bytes 8192` and retained-stream `--from-line`/`--lines`. Search accepts repeated literal `--query` values and `--context`; it searches only captured output, not necessarily the full source file. Follow `nextOffset` until `end` when complete coverage is required. Never treat omissions as absence or completed review coverage. Required rule/handoff/evidence reads remain exact and complete through their prescribed paths. Secrets are not masked. Compact is not a shell wrapper and never replaces mandatory gate commands. Already bounded native reads remain appropriate when cheaper, disabled or unsupported. Reviewers use compact only within their authorized handoff scope.

Compact command usage is mandatory by default. Treat full or verbose output as an escalation step, not a starting point.

### Required Protocol
1. First pass must use compact, summary, structured (`--json`), bounded, or path-scoped output.
2. Escalate in this order only: `scan -> inspect -> debug`.
3. Use repository-wide or unbounded output only when no scoped equivalent exists or the scoped pass failed to localize the issue.
4. Full output is allowed immediately only for:
   - security, auth, secrets, migrations, or infra-sensitive diagnostics;
   - the first encounter with an unfamiliar tool output format;
   - single-target failure debugging after localization.
5. Before switching to verbose or full output, state briefly why compact output is insufficient.

### Mode Selection
| Mode | Default output policy | Expected usage |
|---|---|---|
| `scan` | compact, bounded, summary-only | quick repo or tool overview |
| `inspect` | scoped, file/path/test-target bounded | localized investigation |
| `debug` | verbose/full, local target only | reproduce or explain a known failure |
| `sensitive` | complete output, no unsafe truncation | auth, secrets, CVE, migration, infra diagnostics |

### Two-Pass Rule
1. Start with compact scan.
2. Narrow to targeted inspect.
3. Escalate to verbose/full output only for the localized target.

Examples:
- `git diff --stat` -> `git diff -- path/to/file.ts`
- `rg -l --max-count=5 pattern src/` -> `rg -C2 pattern src/feature/`
- `pytest -q --tb=short` -> `pytest tests/test_auth.py::test_refresh -vv --tb=long`

### Noisy Commands Require Justification
Do not start with noisy or unbounded commands when a compact equivalent exists.

Examples that must not be first pass without a reason:
- `git diff` without `--stat` or pathspec
- `git log --all`
- `rg` or `grep` across the entire repository without path scope
- `cat` on large files
- `docker logs` / `kubectl logs` without `--tail`
- verbose test runners on the first pass

### Optional Command Reference Appendix
The detailed git, package-manager, test-runner, build/lint, search, Docker, and
Kubernetes cheat-sheet tables live in:
`garda-agent-orchestrator/live/docs/agent-rules/40-command-reference.md`.

Load that appendix only when you need exact command variants for one of those
tools. Do not add the appendix to mandatory `TASK_ENTRY` or `POST_PREFLIGHT`
rule-pack loads; the compact policy above and gate commands below are the
mandatory workflow contract.

### When Full Output Is Required
- Diagnosing a specific test failure — use verbose mode (`--tb=long`, `-v`) for that test only.
- Debugging build/compile errors — read full compiler output, then switch back to compact.
- Security-sensitive commands — never truncate; auth, secrets, CVE, migration outputs must stay complete.
- First encounter with unfamiliar tool output — read full once, then adopt compact flags.

## Agent Gates
Canonical gate surface is the Node CLI router.

```bash
node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "<EXPLICIT_TASK_EXECUTION|TASK_CREATED_FROM_REQUEST>" --requested-depth "<1|2|3>" --task-summary "<task summary>" --planned-changed-file "src/<planned-file>" --planned-changed-file "garda-agent-orchestrator/live/docs/agent-rules/<planned-rule>.md" --artifact-path "garda-agent-orchestrator/runtime/reviews/<task-id>-task-mode.json" --metrics-path "garda-agent-orchestrator/runtime/metrics.jsonl"
node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md"
node garda-agent-orchestrator/bin/garda.js gate classify-change --changed-file "src/<example-file>" --task-intent "<task summary>" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --metrics-path "garda-agent-orchestrator/runtime/metrics.jsonl"
node garda-agent-orchestrator/bin/garda.js gate classify-change --use-staged --task-intent "<task summary>" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --metrics-path "garda-agent-orchestrator/runtime/metrics.jsonl"
node garda-agent-orchestrator/bin/garda.js gate classify-change --task-id "<task-id>" --task-mode-path "garda-agent-orchestrator/runtime/reviews/<task-id>-task-mode.json" --changed-file "src/<example-file>" --task-intent "<task summary>" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json"
node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "POST_PREFLIGHT" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md" --loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/35-strict-coding-rules.md"
node garda-agent-orchestrator/bin/garda.js gate bind-rule-pack-to-preflight --task-id "<task-id>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-mode-path "garda-agent-orchestrator/runtime/reviews/<task-id>-task-mode.json"
node garda-agent-orchestrator/bin/garda.js gate compile-gate --task-id "<task-id>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json"
node garda-agent-orchestrator/bin/garda.js gate required-reviews-check --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>" --code-review-verdict "<verdict>" --db-review-verdict "<verdict>" --security-review-verdict "<verdict>" --refactor-review-verdict "<verdict>" --api-review-verdict "<verdict>" --test-review-verdict "<verdict>" --performance-review-verdict "<verdict>" --infra-review-verdict "<verdict>" --dependency-review-verdict "<verdict>"
node garda-agent-orchestrator/bin/garda.js gate required-reviews-check --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>" --code-review-verdict "SKIPPED_BY_OVERRIDE" --skip-reviews "code" --skip-reason "1-line config hotfix; rollback plan exists"
node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>" --decision "NO_DOC_UPDATES" --behavior-changed false --changelog-updated false --rationale "No behavior/contract/ops-doc impact."
node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>" --decision "NO_DOC_UPDATES" --behavior-changed false --changelog-updated false --sensitive-scope-reviewed true --rationale "API trigger fired but changes are internal-only: no public contract affected."
node garda-agent-orchestrator/bin/garda.js gate completion-gate --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --task-id "<task-id>"
node garda-agent-orchestrator/bin/garda.js gate log-task-event --task-id "<task-id>" --event-type "PLAN_CREATED" --outcome "INFO" --message "<short stage message>" --actor "orchestrator"
node garda-agent-orchestrator/bin/garda.js gate task-events-summary --task-id "<task-id>"
node garda-agent-orchestrator/bin/garda.js gate task-audit-summary --task-id "<task-id>"
node garda-agent-orchestrator/bin/garda.js gate task-audit-summary --task-id "<task-id>" --as-json
node garda-agent-orchestrator/bin/garda.js gate next-step --task-id "<task-id>"
node garda-agent-orchestrator/bin/garda.js gate next-step --task-id "<task-id>" --as-json
node garda-agent-orchestrator/bin/garda.js gate build-scoped-diff --review-type "<db|security|refactor>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.diff" --metadata-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.json"
node garda-agent-orchestrator/bin/garda.js gate build-review-context --review-type "<code|db|security|refactor|api|test|performance|infra|dependency>" --depth <1|2|3> --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --scoped-diff-metadata-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-scoped.json" --output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-context.json"
node garda-agent-orchestrator/bin/garda.js gate record-review-result --task-id "<task-id>" --review-type "<code|db|security|refactor|api|test|performance|infra|dependency>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --review-output-path "garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-output.md" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent:...>"
node garda-agent-orchestrator/bin/garda.js gate record-review-result --task-id "<task-id>" --review-type "<code|db|security|refactor|api|test|performance|infra|dependency>" --preflight-path "garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json" --review-output-stdin --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent:...>"
node garda-agent-orchestrator/bin/garda.js gate validate-manifest --manifest-path "garda-agent-orchestrator/MANIFEST.md"
node garda-agent-orchestrator/bin/garda.js gate human-commit --task-id "<task-id>" --message "<message>"
```

Notes:
- Enter task mode explicitly before preflight; downstream compile/review/completion gates fail without `runtime/reviews/<task-id>-task-mode.json` and timeline event `TASK_MODE_ENTERED`.
- When the likely task file list is already known, pass repeated `--planned-changed-file` entries to `enter-task-mode`. If any planned path is under protected orchestrator roots, the gate must fail early with a remediation command that reruns the same task-mode entry with explicit `--orchestrator-work`; it must not silently auto-enable orchestrator mode.
- Agents must not approve protected task-mode entry for themselves. Commands that use `--orchestrator-work` or `--workflow-config-work` require fresh operator approval, `--operator-confirmed yes`, and `--operator-confirmed-at-utc "<ISO-8601 timestamp>"`.
- After opening baseline downstream rules, record them explicitly via `load-rule-pack --stage TASK_ENTRY`; `classify-change` fails without rule-pack evidence and timeline event `RULE_PACK_LOADED`.
- When task-mode evidence lives at a nondefault path, pass the same `--task-mode-path` through `classify-change`, `load-rule-pack`, `bind-rule-pack-to-preflight`, `compile-gate`, `restart-coherent-cycle`, and `restart-review-cycle`; mixed paths are treated as provenance drift.
- After preflight decides the required reviews, run the exact command printed by `next-step`: either `load-rule-pack --stage POST_PREFLIGHT --preflight-path ...` with the actual downstream rule files opened for this task, or `bind-rule-pack-to-preflight` when current-cycle rule files and hashes are unchanged and only the preflight binding must be refreshed.
- For one task cycle, `classify-change -> POST_PREFLIGHT rule-pack binding -> compile-gate` is a strict sequence, not a parallelizable set. Use `next-step` between each transition; if a newer preflight is classified, rerun downstream gates from the POST_PREFLIGHT command that `next-step` prints against that latest preflight before compile.
- `record-review-result` accepts exactly one reviewer-output source: `--review-output-path` or `--review-output-stdin`.
- For review-context schema version 3 or newer, `record-review-result` validates the generated `Coverage Ledger` before writing a receipt: every current-scope file, behavior boundary, and review category obligation must occur exactly once with concrete changed-file `path:line` evidence, and active `[F-NNN]` findings must be linked bidirectionally from the ledger.
- `--review-output-stdin` is not a bypass path: the gate must first persist raw reviewer input to `garda-agent-orchestrator/runtime/reviews/<task-id>-<review-type>-review-output.md`, then run the same findings-schema, coverage, routing, receipt, and telemetry validation used for file-based ingest.
- In a dirty workspace, prefer `--use-staged` after staging task-related tracked files.
- `--use-staged` includes untracked files by default, so new files are classified even before `git add`.
- Do not use `git add -f` for ignored orchestration control-plane files (`TASK.md`, `garda-agent-orchestrator/runtime/**`, `garda-agent-orchestrator/live/docs/changes/CHANGELOG.md`); their absence from staged diff is expected.
- `human-commit --task-id "<task-id>" --message "<message>"` requires authenticated workspace-local `local_commit.enabled` authority, current completion/audit PASS and exactly accepted staged task scope. Explicit audited ON is durable operator permission; do not ask the commit question again while it remains valid. OFF, omitted/invalid config, copied state or unaudited flags block native commits. Legacy `--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"` cannot override OFF or task checks. Post-commit audit remains mandatory; reset/revert is not normal recovery after a mistaken commit.
- `workflow set` mutates guarded workflow-config policy and requires separate explicit operator approval with `--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"`; agents must not approve workflow-config mutations for themselves.
- `gate record-review-cycle-continuation --decision "allow_one_more_cycle"` records a task-scoped one-shot review-cycle continuation after explicit operator approval. It writes runtime evidence only, does not edit `workflow-config.json`, and must not be described as raising review-cycle limits.
- For maximum precision, pass planned task file list via repeated `--changed-file`.
- In a clean workspace, planned `--changed-file` preflight is only the initial scope hint before implementation. If `next-step` or `compile-gate` later reports scope drift after the real diff exists, treat that as expected planned-scope recovery: rerun the `next-step` command and follow its refresh sequence instead of hand-authoring recovery flags.
- In a clean workspace, `classify-change` can auto-detect changed files from git without additional flags.
- Compile gate is mandatory before review phase, but only run it when `next-step` reports `NextGate: compile-gate`; treat non-zero result as blocking and rerun `next-step` for recovery.
- Compile gate is strict: preflight scope drift blocks execution. Refresh the task scope through `next-step` so `classify-change`, POST_PREFLIGHT rule-pack binding, and `compile-gate` stay bound to the same current preflight.
- Compile gate additionally validates explicit task-mode entry evidence from `enter-task-mode`.
- Compile gate additionally validates post-preflight rule-pack evidence from the current POST_PREFLIGHT command.
- `required-reviews-check` additionally validates compile evidence in `runtime/task-events/<task-id>.jsonl`; without `COMPILE_GATE_PASSED` the review gate fails.
- `required-reviews-check` additionally validates explicit task-mode entry evidence (`TASK_MODE_ENTERED`) before review pass can succeed.
- `required-reviews-check` additionally validates post-preflight rule-pack evidence (`runtime/reviews/<task-id>-rule-pack.json`) before review pass can succeed.
- Explicit `--*-review-verdict` flags are historical compatibility only. New cycles omit them and `required-reviews-check` derives required lane state from validated findings receipts and locked dispositions for `preflight.required_reviews`.
- These defaults do not relax validation: the gate still requires current-cycle artifacts, receipts, review-context bindings, and exact pass tokens; it must not auto-scan `runtime/reviews` for a convenient PASS.
- `required-reviews-check` validates workspace drift against compile evidence scope snapshot; any post-compile changes require re-run of compile gate.
- `required-reviews-check` supports audited override only for code review in tiny low-risk scopes; all other review overrides are rejected.
- `doc-impact-gate` is mandatory before completion; it writes `runtime/reviews/<task-id>-doc-impact.json`. When the preflight detected `api`, `security`, `infra`, `dependency`, or `db` triggers, `NO_DOC_UPDATES` requires `--sensitive-scope-reviewed true` with a rationale explaining why no documentation updates are needed.
- Run `build-review-context` before every required reviewer invocation, even when token economy is inactive; the generated review-context artifact is also lifecycle evidence.
- `build-review-context` writes `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, and `SKILL_REFERENCE_LOADED` automatically for the selected review skill.
- Upstream review dependencies are launch-time guards, not only gate-time guards. Do not launch a dependent downstream reviewer before the required upstream accepted findings receipt reports findings-satisfied for the same cycle.
- Parallel reviewer launch is allowed only for independent review types with no dependency edge in the current cycle; `test` is not independent when upstream non-`test` reviews are required.
- `classify-change` auto-emits `PREFLIGHT_STARTED` and, on failure, `PREFLIGHT_FAILED`; `compile-gate` auto-emits `IMPLEMENTATION_STARTED` before compile execution.
- `completion-gate` validates task-mode evidence, rule-pack evidence, compile evidence, review-gate evidence, doc-impact evidence, rework-after-failure evidence, ordered lifecycle evidence (`PREFLIGHT_CLASSIFIED`, `IMPLEMENTATION_STARTED`, `REVIEW_PHASE_STARTED`), real review-skill telemetry (`SKILL_SELECTED`, `SKILL_REFERENCE_LOADED`), required review artifacts, and best-effort task-event integrity before `DONE`.
- `build-scoped-diff` can also write `runtime/reviews/<task-id>-<review-type>-scoped.json` so reviewer prompts know whether scoped diff fell back to full diff.
- `build-review-context` writes `runtime/reviews/<task-id>-<review-type>-review-context.json` plus a sibling markdown snapshot referenced by `rule_context.artifact_path`; the JSON records selected rule pack, omitted sections, sanitized rule-context metadata, and scoped-diff fallback evidence for token economy mode.
- Classification roots and trigger regexes are configurable in `garda-agent-orchestrator/live/config/paths.json`.
- Optional specialist reviews (`api`, `test`, `performance`, `infra`, `dependency`) become required only when enabled in `garda-agent-orchestrator/live/config/review-capabilities.json`.
- Gate commands can append JSONL metrics to `garda-agent-orchestrator/runtime/metrics.jsonl` for threshold tuning.
- Task event timeline is written to `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl` (plus aggregate `all-tasks.jsonl`) with best-effort append locking for both files.
- New task-event writes include a per-task hash chain (`integrity.task_sequence`, `prev_event_sha256`, `event_sha256`) to detect local tampering, replay, and out-of-order inserts after the fact.
- Task timeline completeness is surfaced by `status` and `doctor`, not just completion-gate.
- Human-readable timeline can be generated with `node garda-agent-orchestrator/bin/garda.js gate task-events-summary`; summary output includes `IntegrityStatus`.
- Compact task audit summary can be generated with `node garda-agent-orchestrator/bin/garda.js gate task-audit-summary --task-id "<task-id>"`; it shows status, gates, changed files, evidence paths, blockers, and final closeout contract data. Use `--as-json` for structured output; on `PASS` it also materializes canonical `runtime/reviews/<task-id>-final-closeout.{json,md}` artifacts. Non-zero exit when status is not `PASS`.
- Deterministic next-step guidance can be generated with `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."`; it reports the next gate command, effective `full_suite_validation` config path/enabled/placement/command, review execution policy, missing artifacts, and review trust status. This is the default task loop, not only a diagnostic fallback.

## Project Discovery Snapshot
- Discovery source: git_index_and_worktree
- Files considered: 515
- Detected stacks: Node.js or JavaScript, TypeScript
- Top-level directories: .agents, .claude, .github, .idea, .node-build, .pytest_cache, .review-temp, .scripts-build, .vscode, docs
- Full report: `garda-agent-orchestrator/live/project-discovery.md`
