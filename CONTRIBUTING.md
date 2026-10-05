# Contributing to Garda

Bug reports and feature proposals are welcome through the repository's issue forms. Search existing issues first; include a minimal reproduction for a bug. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

Send normal contributions to **`dev`** from a branch in your fork. `master` is the default publication branch; maintainers coordinate release changes to it. Before uploading a branch or opening a PR, agree the CI trigger policy with a maintainer as described below.

Issue forms and the default PR template become available in GitHub's interface after maintainers publish them to default branch `master`. A local or `dev`-only commit does not activate them. Until publication, copy `.github/pull_request_template.md` from the source checkout into the PR description; use the same evidence requirements. Publishing templates is a separate maintainer operation.

## Prepare a Source Checkout

Use Git and a supported Node.js runtime: Node 24 is the primary line and Node 22.13+ is the compatibility line. See the [runtime contract](docs/node-runtime-contract.md) for the supported matrix.

```shell
git clone https://github.com/Garda-Studio/garda-agent-orchestrator.git
cd garda-agent-orchestrator
npm ci
npm run build
node bin/garda.js --help
```

`src/**/*.ts` owns runtime behavior; `bin/garda.js` and `dist/**` are compiled outputs. Edit source files and let the build generate the runtime. Consumer installation and source development are described separately in [run methods](docs/run-methods.md).

## Work on a Change

Follow the [contributor workflow](docs/contributor-workflow.md) for fork setup, local Garda onboarding, task creation, validation, and the PR handoff. A fresh clone does not contain the local `AGENTS.md`, `TASK.md`, or `.agents/workflows/start-task.md`: `node bin/garda.js setup --target-root .` materializes them. Complete [AGENT_INIT_PROMPT.md](AGENT_INIT_PROMPT.md) and the `agent-init` gate before starting a task.

Then read the generated source-of-truth entrypoint, `TASK.md`, and the local `.agents/workflows/start-task.md` router. Create a real TODO task with a bounded scope and acceptance criteria. Its configured profile and current evidence determine the required checks and reviews; `next-step` supplies the next command:

```shell
node bin/garda.js next-step T-001 --repo-root .
```

Replace `T-001` with your real task ID. Inspect existing changes before starting and keep unrelated staged or working-tree changes out of your task and commit. Preserve the scope, acceptance criteria, and supported runtime behavior.

AI-assisted contributions follow the same workflow. The contributor remains responsible for understanding the change, its licensing, its checks, and the accuracy of the evidence. An agent's statement that a fix works does not establish completion.

## Required Evidence for Fixes

**Bug-fix contributions are ready for merge only after their tasks have completed through Garda's canonical orchestration lifecycle.** Provide the native final task report, a current task audit with `PASS`, and navigator `DONE`, tied to the source contents submitted in the PR. This applies to fixes written by people and by AI agents. A manually edited task status, copied receipts from another task, screenshots, or a free-form agent summary cannot replace native closeout.

Use the PR template and include:

- Task IDs, cycle identifiers, effective profiles, and native completion/audit status.
- Garda version and tool source commit or build identity; OS, Node/npm versions, and provider/model when relevant.
- The PR base and current HEAD, audited source revision, and native file/content fingerprints covering the submitted fix.
- Garda-generated final reports and machine-readable audits, plus actual validation commands/results and required independent review results. State untested platforms and remaining limitations.

See [collecting task evidence](docs/contributor-workflow.md#collect-task-evidence) for the existing commands and safe attachment procedure. Screenshots are optional supporting material. Changes to audited source require refreshed checks and evidence according to Garda's lifecycle; a commit that preserves audited bytes is not a reason to invent a new receipt.

A maintainer checks the evidence and its correspondence to the current PR before accepting a fix. Hashes and locally generated JSON provide traceability; they do not independently prove honest execution. There is no automatic contribution-proof verifier yet. Manual checks must never be presented as native Garda `DONE`/`PASS`.

## CI and Pull Request Review

CI runs require explicit authorization from the repository owner for this project and the selected checks. Preparing a PR or requesting verification does not authorize cloud CI. Prefer relevant local checks; retain every mandatory Garda gate and use the affected test scope through the audited workflow configuration. A full release preflight is for a release candidate, not a default requirement for every contribution.

Before any push or PR creation, inspect the workflows in the source and target repositories. Existing automatic push/PR triggers must be reconciled with the maintainer before proceeding; a skip marker is not a substitute for a consistent trigger policy. Do not dispatch or rerun Actions to obtain a green badge without approval. After a failure, inspect its logs and rerun only the failed check/platform/runtime; a fixed commit needs a new authorized filtered run, not a rerun of the old commit. See [branch and CI guidance](docs/branch-protection.md).

Use a concise conventional commit, explain the problem and resulting behavior, link the relevant issue, and attach the evidence. Maintainers review the patch and request any needed follow-up. New source changes must be covered by current task evidence before merge.

Optional human-readable plans live at `garda-agent-orchestrator/runtime/plans/<task-id>.md`; their absence is normal. See [task planning](docs/task-plan-workflow.md) for the distinct structured JSON plan contract. Use [HOW_TO.md](HOW_TO.md) for onboarding and common operations, [the work example](docs/work-example.md) for a walkthrough, and [the CLI reference](docs/cli-reference.md) for command details.

## Developer Checks

| Command | Purpose |
|---|---|
| `npm run build` | Compile the publishable runtime. |
| `npm run typecheck` | Check dependency boundaries and TypeScript types. |
| `npm run typecheck:unused` | Check unused locals and parameters. |
| `npm run lint` | Lint maintained TypeScript sources and tests. |
| `npm test` | Run the default Node test suite. |
| `npm run quality` | Run type checks, lint, coverage thresholds, and the production dependency audit. |
| `npm run test:packaging` | Check packed runtime and package contents when packaging changes. |

During orchestrated work, use the validation commands routed by `next-step`; standalone commands do not replace mandatory gate evidence. Choose tests for the affected behavior and adjacent regressions before the task, using audited `workflow set` when a configuration change is necessary. Keep the validation gate enabled; do not disable it or weaken timeout/retry policy to make a task pass. Dependency audits need registry access. Release preparation additionally uses [the release-readiness contract](docs/release-readiness.md) from a clean candidate.

## Local Control-Plane Files

`TASK.md` and the local Garda runtime/control-plane state are intentionally ignored by Git. Do not force-add the queue, task evidence, generated artifacts, local answers, or private workspace state to a contribution. Commit the intended source/docs change with its relevant tests, and describe the problem, resulting behavior, and verification. Report security vulnerabilities through [SECURITY.md](SECURITY.md).

### Canonical Task Queue Formatting

Keep one uninterrupted table under `## Active Queue`, with these nine columns in order. The following is a formatting example, not a task to execute:

```markdown
## Active Queue

| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |
|---|---|---|---|---|---|---|---|---|
| T-001 | 🟦 TODO | P3 | docs/example | Clarify usage | contributor | 2026-09-07 | balanced | Document input A \| B; verify the example. |
```

Use unique task IDs, canonical status tokens, a valid configured profile, and one physical line per row. Escape literal pipes in cell text as `\|`, including inside inline code. Put headings and explanatory paragraphs outside the table so the parser can see every task. A malformed follow-up row is not accepted as review evidence; fix its formatting instead of weakening matching or parsing. Gates own active lifecycle transitions: a manual row edit is not proof of review or completion.
