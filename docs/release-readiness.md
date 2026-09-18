# Release Readiness

This tracked checklist is the release-cut source of truth for static readiness.
Local `TASK.md` and `TASK_DONE.md` files are intentionally gitignored operator
queues and must not be treated as publish blockers by release validation.

## 1.4.3

- [x] Package metadata is aligned to `1.4.3` in `package.json`, `package-lock.json`, `VERSION`, and the tracked package-surface baseline.
- [x] The changelog adds a patch-release section without changing prior release notes.
- [x] Deployed workspace validation requires compiled `dist/src` runtime paths instead of the intentionally unpublished TypeScript source tree; compiled-only packaging remains unchanged.
- [x] Regression coverage includes real packed installation, setup, successful verification, and rejection of a missing deployed runtime entrypoint.
- [x] The release pipeline retains full tests, coverage, lint, type checks, and packed-package validation without bypassing release gates.

Publication uses the existing tag-driven workflow and npm staged approval with maintainer 2FA. No production dependencies, consumer install scripts, or CI safety controls are changed.

Before creating the new tag, the release commit must pass the clean-tree `npm run release:preflight`. This static checklist records the release scope, not a substitute for that execution evidence.

## 1.4.2

- [x] Package metadata is aligned to `1.4.2` in `package.json`, `package-lock.json`, `VERSION`, and the tracked package-surface baseline.
- [x] `CHANGELOG.md` starts with a populated `1.4.2` section, while release readiness verifies that the complete released tail beginning at `1.3.0` remains content-identical to the `v1.3.0` tag.
- [x] Release readiness rejects any existing `v1.4.2` tag. The publish workflow independently validates tag/version parity and rejects both reruns and any distinct prior `publish.yml` run for the same tag through read-only GitHub Actions history.
- [x] All commits after `v1.3.0` were audited by conventional prefix; the history includes the intentional `dev`-to-`master` release merge, no explicit breaking-change markers, and no tracked-file deletions.
- [x] The unpublished `v1.4.0` and `v1.4.1` tags both failed validation before npm staging, were removed, and are not reused; `v1.4.2` is a fresh release identity on verified `master` history.
- [x] README, CLI, Node runtime, Node platform, and release-runbook compatibility references name the `1.4.x` line and preserve the Node 22.13+/24 support matrix.
- [x] Release notes cover the guarded review catalog, compatibility migration, dynamic review ordering, authenticated delta/full remediation, correction and recovery hardening, workflow manifests, operator UI changes, and safer uninstall behavior.
- [x] The bundled `1.4.2` update announcement gives existing users an actionable catalog validation command and keeps explicit migration optional and preview-only.
- [x] All tracked Markdown documents are covered by the repository-relative link validator, and package smoke separately validates links in the installed public-document surface.
- [x] Published tarballs retain the compiled-only CLI contract and omit `src/**`, `tests/**`, `.node-build/**`, and `.scripts-build/**`.
- [x] The deterministic offline package-surface baseline is refreshed from the final `1.4.2` packed surface with a release-audit rationale.
- [x] `.github/workflows/publish.yml` remains the primary Trusted Publishing workflow for `v*` tags, and its `npm-release` GitHub Environment is release-tag restricted.
- [x] npm Trusted Publisher settings remain GitHub Actions publisher `Shubchynskyi` / `garda-agent-orchestrator` / `publish.yml`, with allowed action `npm stage publish`.
- [x] The public package still requires npm-side staged approval with maintainer 2FA; after verification, Publishing access can remain `Require two-factor authentication and disallow tokens`.
- [x] Post-publish verification includes npm `latest`, package integrity/provenance visibility, and `npx --yes garda-agent-orchestrator@1.4.2 --version`.
- [x] Frozen profile/effective-review-snapshot behavior is aligned across compile, POST_PREFLIGHT rule-pack, required-review, and `next-step` flows; the final full Node suite completes without failures.
- [x] Review selection, findings/disposition, final closeout, review-cycle restart, public-command inventory, lifecycle cleanup, and lifecycle writer-audit regressions are resolved and covered by focused plus full-suite tests.
- [x] The tracked package metadata, template, update announcement, and release documentation report `1.4.2`; embedded-bundle parity remains explicitly skipped when no tracked embedded items exist.
- [x] The final handoff contract requires a clean-tree `npm run release:preflight` on Node 24 and the supported Node 22.13+ line; creating or pushing `v1.4.2` and approving the staged npm release remain explicit operator actions after the release commit.

### Current validation decision

**READY FOR RELEASE COMMIT as of 2026-08-29 on Windows with Node 24.11.1 and
npm 11.18.0.** The final full Node run completed all 36 shards with 9,176
passing tests, 28 intentional skips, and zero failures or cancellations. The
exact `c8 npm test` coverage run repeated the same 9,204-test result and reported
90.01% statements/lines, 79.34% branches, and 93% functions.

Dependency-boundary validation, TypeScript checks including unused-symbol
enforcement, ESLint, both npm audits, release smoke, packaging smoke, version
parity, and deterministic package-surface validation pass. The refreshed local
bundle passes setup, verify, and manifest validation. Embedded-bundle parity is
reported as `SKIPPED` by design because the generated bundle is gitignored and
there are no tracked embedded parity items.

There are no remaining known code or test blockers. The worktree intentionally
contains the uncommitted release preparation, so it is ready for a release
commit but not yet for a tag. After that commit, run the exact clean-tree
`npm run release:preflight` on Node 24 and the supported Node 22.13+ line before
creating `v1.4.2`; the target tag is currently unassigned.

The local proof intentionally runs before `v1.4.2` exists. After the operator
pushes the tag, the workflow verifies that tag against `package.json`, both
lockfile version fields, and `VERSION`. It then deletes only the checkout's
ephemeral `refs/tags/v1.4.2` ref before running the unchanged preflight. No
environment variable can make an assigned version pass readiness.

### Package-growth impact evidence

Compared with the published `1.3.0` baseline, the final `1.4.2` packed surface
grows from 1,333 files and 15,160,503 unpacked bytes to 1,377 files and
16,471,563 bytes: 44 files (3.30%) and 1,311,060 bytes (8.65%). The increase is
the compiled review-catalog, remediation, workflow-manifest, UI, template, and
public-documentation surface. It adds no production dependencies or consumer
`preinstall`, `install`, or `postinstall` scripts.

The lexical review counters change by `exec +4`, `fetch +5`, `fs +205`,
`readFile +33`, and `writeFile +6`; `child_process` is unchanged. These are
expected references in the audited runtime and test-supporting release surface,
not vulnerability findings. The tracked baseline binds the final counts so
growth beyond its explicit allowances, lifecycle-script drift, or lexical
risk-signal growth fails release validation.

The package smoke treats install and cold CLI startup as measured release
contracts. On Windows with Node 24.11.1 and npm 11.18.0, the focused package
smoke measured a local tarball install at 6,392 ms and a packaged `--version`
launch at 3,541 ms. The regression ceilings are 180,000 ms for local install on
Windows runners, 60,000 ms on Linux and macOS, and 10,000 ms for cold startup.
The Windows allowance accounts for shared-runner filesystem and antivirus
variance while remaining below the separate 300,000 ms functional timeout;
functional pack, install, and invocation checks remain mandatory. The focused
packaging suite passed all 16 tests, and both `npm audit` and `npm audit
--omit=dev` reported zero known vulnerabilities on 2026-08-29.

## 1.3.0

- [x] Package metadata is aligned to `1.3.0` in `package.json`, `package-lock.json`, `VERSION`, and the tracked package-surface baseline.
- [x] `CHANGELOG.md` starts with a populated `1.3.0` section, while release readiness verifies that the complete released tail beginning at `1.2.0` remains content-identical to the `v1.2.0` tag.
- [x] Release readiness rejects any existing `v1.3.0` tag. Before removing only the ephemeral local tag ref, the publish workflow validates tag/version parity and rejects both reruns and any distinct prior `publish.yml` run for the same tag through read-only GitHub Actions history.
- [x] README, CLI, Node runtime, Node platform, and release-runbook compatibility references name the `1.3.x` line and preserve the Node 22.13+/24 support matrix.
- [x] All tracked Markdown documents have been scanned for broken repository-relative links, and package smoke separately validates links in the installed public-document surface.
- [x] The SQLite documentation records the final no-cutover decision: each database is workspace-local and disposable, canonical files remain authoritative, and only benchmark-qualified bulk aggregation plus derived project-memory search use the catalog.
- [x] The release code-health audit records no oversized classes; the remaining large functional coordinators are known refactor debt and are not mechanically split during release preparation.
- [x] Published tarballs retain the compiled-only CLI contract and omit `src/**`, `tests/**`, `.node-build/**`, and `.scripts-build/**`.
- [x] The deterministic offline package-surface baseline is refreshed from the final `1.3.0` packed surface with a release-audit rationale.
- [x] `.github/workflows/publish.yml` remains the primary Trusted Publishing workflow for `v*` tags, and its `npm-release` GitHub Environment is release-tag restricted.
- [x] npm Trusted Publisher settings remain GitHub Actions publisher `Shubchynskyi` / `garda-agent-orchestrator` / `publish.yml`, with allowed action `npm stage publish`.
- [x] The public package still requires npm-side staged approval with maintainer 2FA; after verification, Publishing access can remain `Require two-factor authentication and disallow tokens`.
- [x] Post-publish verification includes npm `latest`, package integrity/provenance visibility, and `npx --yes garda-agent-orchestrator@1.3.0 --version`.
- [x] The final local handoff requires a clean-tree `npm run release:preflight`; creating or pushing the tag and approving the staged npm release remain explicit operator actions.

The local proof intentionally runs before `v1.3.0` exists. After the operator
pushes the tag, the workflow verifies that tag against `package.json`, both
lockfile version fields, and `VERSION`. It then deletes only the checkout's
ephemeral `refs/tags/v1.3.0` ref before running the unchanged preflight. No
environment variable can make an assigned version pass readiness.

## 1.2.0

- [x] Package metadata is aligned to `1.2.0` in `package.json`, `package-lock.json`, and `VERSION`.
- [x] `.github/workflows/publish.yml` is the primary tag-driven release workflow for `v*` tags and runs on GitHub-hosted Ubuntu with Node 24.
- [x] The publish workflow validates tag/version parity, runs `npm ci`, runs `npm run release:preflight`, and records `npm pack --dry-run` output before any stage-publish job can start.
- [x] The `publish` job targets the GitHub Environment `npm-release`, uses `permissions: contents: read, id-token: write`, disables package-manager cache, upgrades npm CLI to `11.15.0+`, reruns release proof before staging, and stages with plain `npm stage publish` through npm Trusted Publishing/OIDC.
- [x] The `npm-release` GitHub Environment setup is documented as release-tag restricted to `v*`; GitHub required reviewers are optional and not required for the solo maintainer release path.
- [x] npmjs.com Trusted Publisher settings are documented as GitHub Actions publisher `Shubchynskyi` / `garda-agent-orchestrator` / `publish.yml`, Environment `npm-release`, and allowed action `npm stage publish`.
- [x] npm-side staged approval with maintainer 2FA is documented before the staged package becomes public.
- [x] Post-verification hardening is documented: set Publishing access to `Require two-factor authentication and disallow tokens` and remove obsolete publish tokens only after Trusted Publishing staged publish succeeds.
- [x] Release operators are told not to claim provenance until npm shows package provenance/attestation evidence for the public package.
- [x] Post-publish verification includes npm `latest`, package integrity/provenance visibility, and `npx --yes garda-agent-orchestrator@1.2.0 --version`.
- [x] Published tarballs use the compiled-only runtime surface: `dist/**`, `bin/garda.js`, templates, metadata, and public docs remain, while `src/**`, `tests/**`, `.node-build/**`, and `.scripts-build/**` are excluded and package smoke proves install/invoke without consumer build tooling.
- [x] Release preflight writes and validates an offline deterministic package-surface artifact against the tracked explicit baseline; intentional material growth requires a reviewed baseline update with an audit rationale.

### Offline package-surface contract

`npm run validate:package-surface` is the final `release:preflight` step. It builds
the publish runtime, materializes the same legacy compatibility document used by
`prepack`, and inspects `npm pack --dry-run --json --ignore-scripts`. It neither
contacts Socket nor requires a Socket token or any other release-scoring network
service. The current deterministic JSON artifact is written to the gitignored
`garda-agent-orchestrator/runtime/release/package-surface-current.json` path.

The tracked reference is
`config/release-package-surface-baseline.json`. The comparison contract is:

- `fileCount` and `unpackedSizeBytes` may grow only by the numeric allowances in
  the baseline. The default reviewed allowances are 10 files and 256 KiB.
- npm lifecycle scripts are recorded as a sorted name-to-command map. Any add,
  removal, or command change fails the comparison.
- executable `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, and `.mts` files are scanned
  for the lexical signals `child_process`, `exec`/`execFile` variants, `fetch`,
  `node:fs` or `fs.` use, `readFile` variants, and `writeFile` variants. The
  baseline allows no unreviewed signal-count growth.
- The sorted packed path-and-size manifest is SHA-256 bound in the current
  artifact. An explicitly supplied prior artifact can replace the baseline with
  `--prior-artifact <path>` and uses the conservative default growth allowances.

These lexical counts are review prompts, not vulnerability findings. A failure
means inspect the package diff; it does not assert that the matched code is
unsafe. For intentional growth, refresh the tracked baseline only with the
explicit audited command and commit the rationale with the resulting diff:

```powershell
node scripts/node-foundation/build-scripts.cjs validate-release.js package-surface-baseline --confirm-baseline-update --rationale "Describe the reviewed package growth"
```

The command never silently updates the baseline: both the confirmation flag and
a non-empty rationale are mandatory. External Socket scores remain advisory and
may temporarily move because of signals such as `recentlyPublished`; their
availability and score are not release gates.

## 1.1.0

- [x] Update provenance and self-update trust policy are documented and validated.
- [x] Protected control-plane strict scanning has explicit symlink and cache trust contracts.
- [x] Review follow-up materialization does not invalidate unchanged review scope.
- [x] Delegation target validation checks package identity and path containment.
- [x] Trusted source-checkout setup and bootstrap commands can repair source/bundle parity.
- [x] Sourceful package distribution policy is documented and enforced.
- [x] Release docs, package metadata, manifest, provider wording, and runtime wording are aligned.
- [x] Completion-gate success routes agents to final closeout before commit guidance.
- [x] Pre-release audit separated release proof from readiness-validator false negatives.
- [x] Release-readiness validation uses git-tracked checklist state instead of local task queues.
- [x] CI smoke validation accepts multiline lifecycle run scripts without weakening matrix checks.
- [x] Release preflight runs a short runtime-contract smoke suite before the expensive full proof.
- [x] Residual release-security baseline labels existing security checks as blocking or informational and reports action-pinning and update-source policy diagnostics without adding a duplicate pipeline.
