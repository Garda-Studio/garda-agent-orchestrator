# Project Validation Recipes

Garda uses the same source, execution and independent case-resolution mechanism in ordinary projects. A project declaration is optional command metadata, not an opt-in universal mode. Existing projects keep their configured commands, permissions and tooling after an update. Mandatory source admission does not require JavaScript syntax, English case names or conventional test directories.

## Ordinary project checks

Where a trust-boundary matrix is required, cite each actual contained source as `path#case selector`. The selector is an opaque project identity; the scenario and expected behavior may use the project's language. Source identities are captured before execution. A bound reference does not prove that an assertion exists or that it ran.

Run the actual focused project command through the task-owned `gate run-intermediate-command --command-source targeted-test --command "<actual project command>"` route selected by `next-step`. Garda retains current preflight/source and process/output identities. Use the project's actual configured command, never a guessed `npm test` command. Known runner suggestions are conveniences; unfamiliar runners remain eligible through an explicit bounded invocation.

Current independent code/test reviewers receive each selected case's source, execution record and retained output. They must resolve its behavior with an exact quotation from that output. Missing cases, skipped cases, zero-case output and unresolved semantics cannot close selected obligations merely because the process exited zero. Compile-only and documentation-only work retain their own gates and do not acquire fabricated test results.

Active and completed-task audits inspect those same bound reports with or without a project declaration. Native DONE selects read-only retained inspection with current completion provenance; it does not authorize execution or waive source and report integrity.

## Declare the existing project command

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
node bin/garda.js workflow set --target-root "." --project-validation-contract "project-validation.json" --reason "Admit the existing project validator" --operator-confirmed yes --operator-confirmed-at-utc "<actual valid operator approval UTC>"
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
