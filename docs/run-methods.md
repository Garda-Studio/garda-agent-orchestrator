# Run Methods

Copy-paste command reference for common Garda Agent Orchestrator launch methods.

Current package version source in this repository: `VERSION`.

## 1. Run Directly From Source Tree

Use this when testing the repository itself without packing or installing.
Compile first so `src/bin/garda.ts` is emitted as `bin/garda.js` and can launch the built runtime.

```text
cd D:\Projects\garda-agent-orchestrator

npm run build

node .\bin\garda.js
node .\bin\garda.js --help
node .\bin\garda.js setup --target-root . --no-prompt --assistant-language English --assistant-brevity concise --source-of-truth Codex --enforce-no-auto-commit false --claude-orchestrator-full-access false --token-economy-enabled true
node .\bin\garda.js status --target-root .
node .\bin\garda.js agent-init --target-root . --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "AGENTS.md" --project-rules-updated yes --skills-prompted yes
node .\bin\garda.js doctor --target-root . --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```

## 2. Global Install From Published npm Package

Use this for normal day-to-day CLI usage.

```text
npm install -g garda-agent-orchestrator

garda
gao
garda-agent-orchestrator
```

## 3. Run Through `npx` From Published npm Package

Use this after the package is public on npm.
Use this only when you want a temporary run without global install.
Use the package name with `npx`; the shorter `garda` and `gao` names are CLI aliases after install, not npm package names.

```text
npx -y garda-agent-orchestrator
npx -y garda-agent-orchestrator setup
npx -y garda-agent-orchestrator status --target-root .
```

## 4. Install From Local Repository Folder

Use this to test package behavior without publishing.

```text
mkdir C:\Temp\garda-folder-test
cd C:\Temp\garda-folder-test
npm init -y
git init

npm install D:\Projects\garda-agent-orchestrator

npx garda-agent-orchestrator
npx garda-agent-orchestrator setup --target-root . --no-prompt --assistant-language English --assistant-brevity concise --source-of-truth Codex --enforce-no-auto-commit false --claude-orchestrator-full-access false --token-economy-enabled true
npx garda-agent-orchestrator status --target-root .
```

## 5. Pack To `.tgz` And Test Like a Real npm Artifact

This is the best pre-publish smoke test.

```text
cd D:\Projects\garda-agent-orchestrator
npm pack --dry-run
npm pack

mkdir C:\Temp\garda-npm-test
cd C:\Temp\garda-npm-test
npm init -y
git init

npm install D:\Projects\garda-agent-orchestrator\garda-agent-orchestrator-<current-version>.tgz

npx garda-agent-orchestrator
npx garda-agent-orchestrator setup --target-root . --no-prompt --assistant-language English --assistant-brevity concise --source-of-truth Codex --enforce-no-auto-commit false --claude-orchestrator-full-access false --token-economy-enabled true
npx garda-agent-orchestrator status --target-root .
```

## 6. Run Local Binary After `npm install`

Useful when you want to avoid `npx`.

```text
.\node_modules\.bin\garda.cmd
.\node_modules\.bin\gao.cmd
.\node_modules\.bin\garda-agent-orchestrator.cmd
```

## 7. Global Install From Local `.tgz`

Use this to test the global CLI before publish.

```text
cd D:\Projects\garda-agent-orchestrator
npm pack
npm install -g .\garda-agent-orchestrator-<current-version>.tgz

garda
garda setup
garda status --target-root .
```

## 8. Recommended Local Validation Before Publish

```text
cd D:\Projects\garda-agent-orchestrator

npm run release:preflight
npm run test:release-smoke
npm run test:packaging
npm run validate:release
node .\bin\garda.js gate validate-manifest --manifest-path MANIFEST.md
```

`npm run release:preflight` is the final release-readiness command. It first runs `npm run validate:release-readiness`, which checks static alignment for package scripts and files, CI update-smoke wiring, runtime-state docs, security/audit package surface, manifest-listed docs, and the tracked `docs/release-readiness.md` release checklist. It then runs `npm run test:release-smoke`, a short deterministic suite for task id parsing, task-event append integrity, basic next-step routing, and status/doctor formatting, before the full `npm run validate:release` proof. Packaging smoke is a separate slow smoke command, `npm run test:packaging`, and remains part of `npm run validate:release`.

`npm run validate:release` is the explicit release contract:

```text
npm run validate:clean-worktree
npm run validate:version-parity
npm run build
npm run typecheck
npm run typecheck:unused
npm run lint
npm run coverage
npm run audit:prod
npm pack -> npm install <tarball> -> invoke the packaged CLI
npm run validate:clean-worktree
```

`npm run validate:clean-worktree` blocks release handoff when Git cannot prove a `HEAD`, branch/status state, or clean tracked/untracked worktree. Clean detached `HEAD` states are valid for reproducible CI and package checks.

`npm run typecheck:unused` runs `tsc -p tsconfig.node-foundation.json --noEmit --pretty false --noUnusedLocals --noUnusedParameters`. Both `quality` and `quality:fast` run it immediately after ordinary `typecheck`, before lint, coverage, and production audit, so unused imports, locals, parameters, and types are an explicit release-quality failure instead of a local-only diagnostic.

`npm run coverage` wraps the regular `npm test` path with `c8` reporting, and `npm run coverage:fast` wraps the fast shard. Coverage is scoped to maintained source boundaries (`src`, maintained `scripts`, and `bin`) with `all=true`, so unexecuted maintained source is included in reports instead of being silently omitted. The test build emits source maps so c8 can observe the staged `.node-build/src` and `.node-build/scripts/node-foundation` execution projection, then report the maintained source surface instead of generated output. Generated or retained trees such as `dist`, `.node-build/tests`, `.scripts-build`, `coverage`, deployed runtime artifacts, `node_modules`, and tests are excluded. Global thresholds start conservatively at 35% for statements, functions, and lines and 55% for branches; `check-coverage=true` makes either coverage command fail below those floors so they can be ratcheted upward without imposing an unrealistic initial release blocker. Release-validation CI uploads `coverage/lcov.info` for every OS and Node matrix leg, including threshold failures when the report exists. The final `pack -> install -> invoke` proof is executed by `tests/node/packaging/pack-smoke.test.ts` through `npm run test:packaging` after the strict TypeScript runtime, unused-symbol enforcement, lint, coverage, production audit, and supporting build scripts have already passed.

`npm run archive:source` creates a deterministic tracked-source tar archive under `release-archives/` using `git ls-files`, excluding generated or local runtime trees such as `node_modules`, `coverage`, `.node-build`, `.scripts-build`, `dist`, and `garda-agent-orchestrator/runtime`. `npm run archive:evidence` creates a separate evidence tar from allow-listed proof outputs such as coverage, final task reviews, task events, ledgers, metrics, reports, project-memory impact artifacts, and manual-validation logs; generated reviewer launch/context support artifacts stay out of the handoff. Evidence archiving does not delete local runtime artifacts, skips known secret or credential paths, and fails closed when allow-listed text evidence contains credential-like content; keep release source handoff and generated proof handoff as separate files.

Direct `npm pack` and `npm pack --dry-run` run the package `prepack` lifecycle, which enforces a clean worktree before package preparation and again after `build:publish-runtime`.

## 8.1 Tag-Driven npm Staged Publish

The primary npm release path is now tag-driven through `.github/workflows/publish.yml`, not a local `npm publish`.

Before pushing `v1.4.2`, complete these repository and registry checks:

1. Run `npm run release:preflight` from a clean local worktree before creating the release tag. Local readiness fails if the target version tag already exists.
2. Configure the GitHub repository Environment `npm-release` for release tags. Use selected deployment branches/tags so only tags matching `v*` can deploy to this environment. GitHub required reviewers are optional for the solo-maintainer flow and must not be treated as the release approval control when no second reviewer exists.
3. On npmjs.com, open the `garda-agent-orchestrator` package settings and configure Trusted Publisher:
   - Publisher: GitHub Actions.
   - Organization or user: `Shubchynskyi`.
   - Repository: `garda-agent-orchestrator`.
   - Workflow filename: `publish.yml`.
   - Environment name: `npm-release`.
   - Allowed action: `npm stage publish`.
4. Enable 2FA for the maintainer account and use npm staged publishing approval as the human release approval. `npm stage publish` runs non-interactively in CI with npm CLI `11.15.0+`; the staged package becomes public only after npm-side approval with 2FA through npmjs.com or the npm CLI.
5. Keep old automation tokens disabled or unused during the first OIDC staged publish attempt, but do not remove the rollback path until the Trusted Publishing staging run succeeds.
6. Push the matching tag only after package metadata, `VERSION`, changelog, and `docs/release-readiness.md` all name the same version.

The tag-triggered workflow checks out full tag history and first validates the
GitHub tag against all version metadata. It then removes only the ephemeral
local tag ref from its disposable checkout before rerunning the unchanged
`release:preflight`. The preflight compares the complete released changelog
tail with the prior release tag. There is no environment-variable bypass in
release readiness: every invocation rejects an existing target tag. Before
removing the local ref, the validate job uses read-only GitHub Actions API
access to reject any different historical `publish.yml` run for the same tag;
both jobs also reject `github.run_attempt` values above `1`. A rerun or a new
run after deleting and recreating a consumed release tag therefore fails
closed. Prepare a new version and tag instead.

After the GitHub Actions publish job completes, inspect the staged package on npm and approve it with maintainer 2FA. Do not claim the package is public until npm staged approval completes.

After npm staged approval completes, verify:

```text
npm view garda-agent-orchestrator@latest version dist.integrity
npm view garda-agent-orchestrator@1.4.2 version dist.integrity
npx --yes garda-agent-orchestrator@1.4.2 --version
```

Also verify the package page or npm metadata shows provenance/attestation for the public package before claiming provenance in release notes. After that verification, set npm Publishing access to `Require two-factor authentication and disallow tokens`, then remove obsolete long-lived publish tokens from npm and GitHub secrets.

## 9. Update And Rollback In A Deployed Workspace

```text
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --apply --no-prompt
garda update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
garda update git --target-root "." --repo-url "." --check-only
garda rollback --target-root "."
```

Notes:
- Source-tree execution is compile-first: rebuild after changing `src/**/*.ts`, `tests/node/**/*.ts`, or `scripts/node-foundation/**/*.ts`.
- Direct `node --test .node-build/...` runs are producer-consumer flows: refresh `.node-build/` with `npm run build:node-foundation` or `npm test` before the consumer, and do not overlap the producer with the consumer.
- `check-update` is compare-first.
- `update` applies immediately.
- `update git` uses a git clone source instead of npm; with no extra flags it uses the default GitHub repository.
- `rollback` restores the latest saved rollback snapshot and the matching bundle backup when available.

## 10. After CLI Setup: Agent Handoff

After primary setup, give the agent:

```text
<project-root>\garda-agent-orchestrator\AGENT_INIT_PROMPT.md
```

The agent should then:
- validate and normalize `AssistantLanguage`;
- fill project context files;
- optionally use `garda skills suggest --target-root .` to recommend built-in packs from the compact skills index;
- replace placeholders in `live/docs/agent-rules/40-commands.md`;
- run `garda agent-init --target-root . --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "<active-agent-files>" --project-rules-updated yes --skills-prompted yes`;
- only after `agent-init` passes, run `garda doctor --target-root . --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"`.
