# Contributor Workflow

Use this route when changing Garda's source or public documentation. Consumer installation is covered by [run methods](run-methods.md); contribution requirements are defined in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Fork and Prepare a Branch

Search existing issues and discuss broad behavior changes before implementing them. Fork `Garda-Studio/garda-agent-orchestrator` on GitHub. Create a focused branch from upstream `dev`:

```shell
git clone https://github.com/YOUR_GITHUB_USER/garda-agent-orchestrator.git
cd garda-agent-orchestrator
git remote add upstream https://github.com/Garda-Studio/garda-agent-orchestrator.git
git fetch upstream dev
git switch -c fix/short-description upstream/dev
npm ci
npm run build
node bin/garda.js --version
```

Replace `YOUR_GITHUB_USER` and `fix/short-description`. These commands use Git, npm, and forward-slash paths supported by Windows PowerShell and Linux shells. Use Node 24, or the supported Node 22.13+ compatibility line, and follow the [runtime contract](node-runtime-contract.md). Work from the repository root. Do not edit generated `bin/garda.js`, `dist`, or staged test output; runtime changes belong in `src/**/*.ts`.

## Initialize the Local Workflow

From this source checkout, use its built CLI throughout the task:

```shell
node bin/garda.js setup --target-root .
```

Complete the interactive setup answers for your language, provider entrypoint, and workspace policy. Setup creates the ignored local task queue, agent entrypoints, shared start-task router, and `garda-agent-orchestrator/live` configuration. These files are expected to be absent before setup; do not download another contributor's queue or copy their runtime receipts.

Give the coding agent [AGENT_INIT_PROMPT.md](../AGENT_INIT_PROMPT.md) from the checkout. It must reuse existing answers, confirm active agent files, establish project context/memory, show the specialist-skills choice, and finish the real `agent-init` gate. Do not pass completion flags before those steps actually happened. See [agent onboarding](../HOW_TO.md#3-finish-setup-through-agent) and the [CLI reference](cli-reference.md).

Confirm readiness with the source CLI:

```shell
node bin/garda.js status --target-root .
node bin/garda.js doctor --target-root . --init-answers-path garda-agent-orchestrator/runtime/init-answers.json
```

Resolve initialization failures before task execution. Do not replace a failed readiness check with a hand-written success record. In this source checkout use `node bin/garda.js`; the longer `node garda-agent-orchestrator/bin/garda.js` route belongs to an installed bundle inside an application workspace.

## Define and Execute a Task

1. Ask the agent to add a unique TODO task to local `TASK.md` with the problem, bounded file scope, acceptance criteria, owner, priority, and a valid configured profile. Follow the [canonical queue format](../CONTRIBUTING.md#canonical-task-queue-formatting). Decompose independent changes instead of widening an active reviewed scope.
2. Read the generated source-of-truth entrypoint, `TASK.md`, and the local `.agents/workflows/start-task.md`. A provider bridge, if configured, routes to the same canonical workflow. Preserve unrelated work; begin from a clean scope or use the lifecycle's explicit/staged isolation.
3. Choose the affected test scope and relevant adjacent regressions. Use the audited `workflow set` route for any required configuration change, with real operator authorization for protected changes. Keep mandatory validation enabled. Scope determines the work, not an automatic full-suite run for every task. Select `docs-only` only for a genuinely eligible scope; README changes do not make code, dependency, or template changes exempt from reviews.
4. Start through the navigator, replacing `T-001` with the real ID:

   ```shell
   node bin/garda.js next-step T-001 --repo-root .
   ```

5. Execute the single next command it prints. Run the navigator again after each command and failure. Implement only after task entry and preflight accept the scope; complete compile/validation, fresh independent reviews, docs/memory/completion, and any other required gates. Do not guess gate order or fabricate approval timestamps. Only the human operator can authorize protected changes.
6. Reach native completion and a current task-audit `PASS`; run the navigator again and require `DONE`. A blocked or incomplete audit is unfinished work, even when a row says DONE or the source has been committed.

Suggested agent instruction:

```text
Execute task T-001 from TASK.md strictly through the orchestrator. Use next-step before the first gate, after each suggested command, and after failures. Preserve all required gates and launch fresh independent reviewers when required.
```

Optional working plans and structured plans have different contracts; see [task planning](task-plan-workflow.md). The [work example](work-example.md) illustrates a lifecycle, while the current navigator remains authoritative for your task.

## Collect Task Evidence

After completion, use the existing audit command and save its JSON with the gate-owned output option. Replace `T-001` in both places:

```shell
node bin/garda.js gate task-audit-summary --task-id T-001 --repo-root . --as-json --output-path garda-agent-orchestrator/runtime/reviews/T-001-contribution-audit.json
node bin/garda.js next-step T-001 --repo-root .
```

The audit must return exit code zero and `PASS`; the navigator must report `DONE`. `task-audit-summary` generates the canonical final artifacts under `garda-agent-orchestrator/runtime/reviews`:

- `<task-id>-final-user-report.md`: the Garda final user report.
- `<task-id>-final-closeout.json` and `<task-id>-final-closeout.md`: canonical closeout details.
- The JSON audit at your chosen output path: current status, gate/review results, evidence paths, scope, and blockers.

Preserve these originals. Collect the completed tasks covering the whole submitted fix, including required decomposition children. Attach public-safe reports and JSON to the PR, or link to a controlled evidence handoff agreed with the maintainer. Add a short metadata summary with task/cycle/profile, Garda version, tool commit or build identity, OS and Node/npm, actual checks and independent reviews, and untested platforms. Obtain values from the real environment and native artifacts, not from a recalled version or planned command.

Record the source revision before validation, the PR base and final HEAD, and the native scope/content fingerprints. Garda's tool identity and the submitted patch identity are separate values when the repository is modifying Garda itself. For an uncommitted task scope, identify its base revision and native content fingerprints; do not claim that the base commit alone contains the patch.

After the authorized local commit, regenerate the current audit and check navigator `DONE` again. Confirm that the PR's source bytes match the audited scope. Any later source change needs the checks/reviews required by Garda and updated evidence. Keep the PR metadata current after rebase or merge; unchanged audited bytes do not justify manually rebinding or rewriting receipts.

Keep private configuration, credentials, unrelated task data, and local absolute paths out of public attachments. Inspect each artifact before upload. Never edit a canonical receipt and present the edited copy as original. When originals contain private details, retain them locally and agree a private handoff; a separately labelled public summary with artifact digests does not substitute for the maintainer's access to the originals. Do not publish `TASK.md`, the whole runtime tree, or a broad `archive:evidence` release archive as PR proof. That command is a workspace evidence archive, not a task-filtered public export.

Screenshots can clarify a UI state but are optional and cannot prove task execution. Maintainers review native evidence against the current patch. The repository does not yet have an automatic public exporter or trusted PR-proof verifier; do not claim automatic verification based only on a checkbox or a supplied JSON file.

## Submit and Respond to Review

Review `git diff` and stage only intended source, tests, and public documentation. Local control-plane files remain ignored. Create a concise conventional commit after completing the required workflow and receiving the applicable commit authorization.

Before pushing or opening a PR, inspect Actions triggers in your fork and upstream. Ask the maintainer to resolve any automatic push/PR trigger conflict with the repository's manual-only CI policy. Do not assume opening a PR or adding a skip token authorizes CI. Any cloud run requires explicit approval of the project, checks, commit, and platform/runtime selection; repository owners also check the shared allowance before dispatch. See [branch and CI policy](branch-protection.md#manual-ci-policy).

Once that boundary is resolved, open the PR against `dev`. Describe the concrete problem and resulting behavior, link the issue, fill the PR template, and provide the evidence and actual checks. Until maintainers publish the templates on default branch `master`, copy `.github/pull_request_template.md` from the source checkout into the PR description yourself; its absence from GitHub's form is not an evidence exemption. Disclose AI assistance and take responsibility for the patch. A maintainer reviews the change and the evidence before merge; passing local Garda gates does not replace human contribution review.

When addressing review comments, return to the appropriate task lifecycle, update source and checks, and refresh the evidence for the revised PR. Do not dispatch broad CI as a debugging loop. Release validation and publication are separate maintainer operations.
