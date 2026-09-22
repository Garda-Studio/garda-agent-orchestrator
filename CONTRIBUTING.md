# Contributing to Garda

## Prepare a Source Checkout

Use Git and a supported Node.js runtime: Node 24 is the primary line and Node 22.13+ is the compatibility line. See the [runtime contract](docs/node-runtime-contract.md) for the supported matrix.

```shell
git clone https://github.com/Shubchynskyi/garda-agent-orchestrator.git
cd garda-agent-orchestrator
npm ci
npm run build
node bin/garda.js --help
```

`src/**/*.ts` owns runtime behavior; `bin/garda.js` and `dist/**` are compiled outputs. Edit source files and let the build generate the runtime. Consumer installation and source development are described separately in [run methods](docs/run-methods.md).

## Work on a Change

Read the checkout's `AGENTS.md` and `TASK.md`, then follow [the shared start-task router](https://github.com/Shubchynskyi/garda-agent-orchestrator/blob/main/.agents/workflows/start-task.md). The selected profile and current task evidence determine the required checks and reviews; `next-step` supplies the next command:

```shell
node bin/garda.js next-step T-001 --repo-root .
```

Replace `T-001` with your real task ID. Inspect existing changes before starting and keep unrelated staged or working-tree changes out of your task and commit. Preserve the scope, acceptance criteria, and supported runtime behavior.

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

During orchestrated work, use the validation commands routed by `next-step`; manual commands do not replace mandatory gate evidence. For a bounded maintenance edit, run the relevant focused check and inspect its diff. Dependency audits need registry access. Release preparation additionally uses [the release-readiness contract](docs/release-readiness.md) from a clean candidate.

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
