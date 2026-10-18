# Project Validation Recipes

Garda uses the same source, execution and independent case-resolution mechanism in ordinary projects. A project declaration is optional command metadata, not an opt-in universal mode. Existing projects keep their configured commands, permissions and tooling after an update. Mandatory source admission does not require JavaScript syntax, English case names or conventional test directories.

Expected-red admission uses the current authenticated test-only scope, including explicit declared test roles outside conventional directories. A literal command can name its changed test input without a recognized runner grammar; opaque selectors use the same explicit selected-case association as ordinary validation. Garda retains the exact source identities, complete nonzero execution and output before implementation. Opaque results remain unresolved. At the ordinary post-implementation review, the reviewer inspects the retained failure together with current GREEN for every unchanged selected case, distinguishing assertion failure from process or dependency failure, skipped cases and incomplete output. No separate early review is added. Timeout, cancellation, termination signals, truncation, changed sources and later failed or unfinished attempts cannot establish acceptance. Existing complete TAP reports remain supported.

Updating an existing project replaces the exact historical built-in trust-boundary prompt with this source/execution guidance. Custom prompts, titles, disabled rules and explicit scope filters remain intact. Full-suite advice preserves the configured command and never substitutes an invented package-manager fallback.

## Ordinary project checks

Existing compile, suite and intermediate commands share a bounded literal-invocation projection. The compile slot declares `compile`, the suite slot declares `test`, and intermediate commands retain their declared test, typecheck or validation purpose. The descriptor records executable and argv; it grants no execution permission or semantic PASS. Current task, preflight, source, output and existing authorization checks remain mandatory.

Configured source-file runners, including PowerShell `-File`, shell scripts and Windows wrapper files, follow the same argument boundary as package-manager wrappers. Inline programs, unsupported shell dispatch, malformed quoting and shell-dependent control syntax remain rejected. Compile retains its existing explicit sequential `&&` support; suite and intermediate commands use one direct invocation. Platform batch execution retains its expansion and escaping restrictions.

Interpreter options must leave an unambiguous file operand. Unknown option prefixes cannot establish a file boundary; use a direct source-file invocation or a trusted wrapper. Arguments after the file operand remain literal data.

Known builder names and lifecycle phases are diagnostic hints rather than evidence of purpose or task-graph behavior. Keep a real compile command separate from the configured suite; exact suite identity and explicitly incompatible purposes remain blocked unless the existing approved mixed-command exception applies. Command evidence retains purpose and literal invocations. Compile chain diagnostics identify the actual executed segment, its exit status and its bounded, redacted output; an unexecuted segment has no fabricated execution record.

If an attempted segment fails without an observed process exit, its evidence retains `execution_error` and `exit_code: null`, along with the preceding segments' output. Later unattempted segments remain absent.

Where a trust-boundary matrix is required, cite each actual contained source as `path#case selector`. The selector is an opaque project identity; the scenario and expected behavior may use the project's language. Source identities are captured before execution. A bound reference does not prove that an assertion exists or that it ran.

Run the actual focused project command through the task-owned `gate run-intermediate-command --command-source targeted-test --command "<actual project command>"` route selected by `next-step`. Garda retains current preflight/source and process/output identities. Use the project's actual configured command, never a guessed `npm test` command. For expected red, the navigator selects an admitted recipe when present; otherwise it explains the native command and selected-case binding without guessing a runner or reporter from filenames or build manifests. Both ordinary commands and admitted opaque recipes retain their actual output for independent interpretation.

Current independent code/test reviewers receive each selected case's source, execution record and retained output. They must resolve its behavior with an exact quotation from that output. Missing cases, skipped cases, zero-case output and unresolved semantics cannot close selected obligations merely because the process exited zero. Compile-only and documentation-only work retain their own gates and do not acquire fabricated test results.

Active and completed-task audits inspect those same bound reports with or without a project declaration. Native DONE selects read-only retained inspection with current completion provenance; it does not authorize execution or waive source and report integrity.

## Declare the existing project command

A recipe may include `report_files`, an array of `{ "path": "reports/result.xml",
"max_bytes": 1048576 }` declarations for files produced by its command. Paths are
relative to the repository root, including when the command uses another `cwd`.
The same bounded capture used by ordinary `--report-file` commands authenticates
these files against the actual attempt start. Reports remain opaque evidence for
independent interpretation; declaring a report does not establish a passing case.
Omitting this field preserves stdout/stderr-only behavior.

For the configured full suite, the agent sets the same declarations through the
audited `workflow set --full-suite-report-files '<JSON array>'` option before task
preflight. Use `[]` to clear them. Each actual attempt retains its own capture and
native start binding. Clean-success stdout cleanup preserves these separate report
artifacts; review, completion and navigation reject changed or unavailable captures.

For a declared command, matrix references use `path#target-id`; the declaration binds that ID to the command's opaque selector. Every required matrix reference must correspond to a declared target. Reusing a source file does not add execution coverage for another case.

Save a declaration inside the repository. The following is a complete shape example: replace the executable placeholder with the absolute path of an already installed regular-file executable, and replace the input paths and target with the actual project files and exact case selector. This example is not an executable authorization.

```json
{
  "schema_version": 1,
  "recipes": [
    {
      "id": "project-check",
      "purpose": "test",
      "executable": "<absolute installed executable>",
      "argv": ["tools/validation-driver", { "target": "case-1" }],
      "cwd": ".",
      "inputs": [
        { "path": "product/Implementation.file", "role": "source" },
        { "path": "checks/Example.case", "role": "test" },
        { "path": "tools/validation-driver", "role": "helper" }
      ],
      "targets": [
        { "id": "case-1", "source": "checks/Example.case", "selector": "прибавление一" }
      ],
      "environment": {},
      "timeout_ms": 5000,
      "max_attempts": 1,
      "max_output_bytes": 4096,
      "max_input_bytes": 65536,
      "required_capabilities": [],
      "result_format": "tap"
    }
  ]
}
```

Inputs and target sources are canonical repository-relative paths using `/`; roles may be `source`, `test`, `helper` or `config`. `cwd` is `.` or a contained repository directory, including a package directory. Literal argv is interpreted from that cwd: an input path remains repository-relative even when its command argument needs a different relative spelling. A `{ "target": "case-1" }` argument expands to that target's exact selector, without renaming Unicode or unfamiliar cases.

Purpose may be `test`, `compile`, `typecheck` or `validation`. Test recipes require exact targets, each pointing to a declared test input. The executable and declared program dependencies are bound to file identities; changing them requires supported readmission. Inline programs and unsupported implicit interpreter program sources are rejected rather than treated as eligibility or permission.

Budgets are explicit: timeout is 100–3,600,000 ms, attempts 1–10, output 1 KiB–16 MiB, and input 1 KiB–64 MiB. Attempts do not grant retries beyond the frozen budget. Literal environment values must not inject programs. `required_capabilities` supports declarations for `offline` and `write_confinement`, but the current local executor has no enforcing provider for them and rejects execution requesting either; local hashes are not attestation.

## Admit, enter and execute

In a source checkout, use the existing audited setter with a real operator approval and its original valid observation time:

```text
node bin/garda.js workflow set --target-root "." --project-validation-contract "project-validation.json" --operator-confirmed yes --operator-confirmed-at-utc "<actual valid operator approval UTC>"
node bin/garda.js next-step "<task-id>" --repo-root "."
```

For a materialized workspace, use `node garda-agent-orchestrator/bin/garda.js` instead. Follow native task entry, planned scope, rule loading and current preflight navigation. Admission does not execute a tool, relax grants, create review receipts or authorize a task by itself. Do not hand-edit the approved contract in workflow configuration or copy another workspace's runtime authority.

When the navigator selects an admitted recipe, use its exact recipe route:

```text
node bin/garda.js gate run-intermediate-command --task-id "<task-id>" --recipe-id "project-check" --repo-root "."
```

Recipe mode accepts task/root, recipe ID and an eligible expected-red request. It forbids raw command, command-source, timeout, preflight, coverage and artifact overrides. `--expect-failure` remains subject to the existing task profile and exact changed test-only scope; expected failure is not terminal PASSED. Preserve current compile/full-suite gates and independent reviews rather than using a recipe as their blanket replacement.

## Read the four phases

1. **Structure:** bind the admitted declaration, current task/preflight, roles, executable and source identities. Bound structure is not executed behavior.
2. **Execution:** retain the actual process exit, timing, bounded output and immutable source archive. Execution success is not semantic acceptance.
3. **Result:** reconstruct the canonical attempt and output. The optional `tap` adapter recognizes exact declared cases and checks host failure, missing/duplicate cases and unsupported output. Opaque successful execution retains UNRESOLVED machine status until independent per-case semantics are resolved; exit code zero alone cannot produce PASSED. Targetless compile/typecheck facts do not become test outcomes.
4. **Independent semantics:** current frozen capable mandatory code/test lanes receive exact target/source/attempt/result obligations. Genuine findings reports must cover their own canonical targets. Missing reports, mismatched identities, current source drift or unresolved results prevent terminal closure. Linked findings and residual risks additionally require the canonical disposition validator to authenticate the locked policy and any required materialized follow-up. A satisfied nonblocking disposition preserves a separately PASSED case; it cannot turn FAILED, UNRESOLVED or skipped evidence into a pass. Review, completion and retained audit consumers forward their current invocation-local checks rather than trusting embedded receipt claims. Existing receipt/context authentication and required review floors still apply.

Unsupported declaration versions fail before settings replacement. Old receipts remain historical evidence; they are not promoted to current semantic acceptance. Read-only inspection of genuine retained DONE evidence grants no new execution or publication authority. Preserve existing queues, user memory, settings and original snapshots during supported updates; do not import foreign grants or WIP identity.

Local qualification covers real custom-driver execution, root/package/unfamiliar layouts and exact Unicode selectors with installed tooling. It does not claim validation of an unavailable language toolchain or operating system.
