# Release Readiness

This tracked checklist is the release-cut source of truth for static readiness.
Local `TASK.md` and `TASK_DONE.md` files are intentionally gitignored operator
queues. Static preflight does not use them. The explicit candidate GO check reads
current `TASK.md` release-lane blockers; task status is not CI or artifact proof.

## Candidate GO/NO-GO

`npm run validate:release-readiness` is the offline static preflight and prints
`ReleaseDecision: NOT_EVALUATED`. Its success is not release approval. After the
final candidate has been frozen and its exact-commit CI and Security runs have
completed, use the explicit candidate check from that clean checkout:

```powershell
npm run validate:release-readiness -- --candidate <absolute-candidate-dir> <commit-sha> <tag> <tarball-sha256> <tarball-name> <owner/repo> <ci-run-id>
```

The command prints `ReleaseDecision: GO` only when every static and candidate
check succeeds. Missing, foreign, stale, failed, skipped or zero-item mandatory
evidence yields `NO_GO` and a nonzero exit. It does not publish or mutate the
candidate. Keep the candidate directory ignored or outside the checkout.

- The clean HEAD and package version must match the explicit commit and tag.
- Repository authority comes from the trusted verifier checkout package repository
  metadata, not the caller argument or mutable Git remote. Matching fork CI and
  Security payloads cannot authorize another repository. The verifier distribution
  itself must be trusted; no caller authority override exists.
- Tarball names must be safe single-file .tgz basenames; path traversal, absolute
  paths, both separator forms and empty names are rejected before evidence lookup.
- The exact tarball bytes and contents manifest are reverified through the
  pack-once candidate adapter; checksums identify bytes and do not claim signing.
- Mandatory embedded parity must inspect actual items and return PASSED.
- Authenticated `gh api` data must show a current successful CI run for the same
  repository and commit, with the complete reviewed Node 22.13.0/24 test matrix,
  Linux/Windows release validation and Linux/Windows/macOS packaged/lifecycle
   smoke. Required job steps cannot be skipped, including ripgrep provisioning
   and each release job's build and embedded bootstrap. The other OS's
   conditional provisioning step may be skipped. Rerun attempts, job identities,
  freshness and reviewed workflow/npm-script contracts are checked.
- Existing `security-evidence.json` is live-reverified through the T-057 adapter
  for the same candidate, full dependency graph and blocking OSV scan.
- The canonical local queue must contain one `release/pre-release-go-no-go`
  boundary. Every row before it forms the release lane. A linked non-release
  feature after the boundary is excluded only when explicitly marked
  `Post-release only;` or `Post-release only.`; incidental notes cannot exempt
  pre-boundary tasks or mandatory release policy. Required security and public
  checksum/provenance prerequisites are T-057 and T-083 (legacy T-1027), with
  their matching semantic areas, wherever they appear. Missing, substituted or
  ambiguous prerequisite identities block GO. Manually decomposed and completed parents are traversed
  recursively through explicit child links; missing, unfinished or cyclic
  children block GO. The boundary itself is the handoff, not its prerequisite.
- Checkout identity, queue bytes, security record and tarball are rechecked after
  live verification. The reported queue digest identifies the operator snapshot.

A GO result is a point-in-time observation, not an atomic lock of a mutable
workspace or external service. Keep the frozen checkout and candidate unchanged;
any later edit requires new affected proof and another GO check. An unavailable
authenticated GitHub client is NO_GO, never substitute local fixture evidence.
The reviewed CI and npm-script digests must be reviewed and synchronized when
those execution contracts change. SBOM and final operator handoff requirements
remain part of the final release boundary.

## Candidate-bound dependency security evidence

CI compact integration uses the official ripgrep 15.2.0 Linux x64 and Windows
x64 archives. The workflow checks pinned archive SHA-256 before extraction and
pinned executable SHA-256 before execution. An existing executable is reused
only when its bytes match that pin. Setup duration is printed for each job;
package-manager metadata refresh and mutable package resolution are avoided.
Upstream download or checksum failure fails the job rather than falling back.

Clean source-clone release validation first runs the supported build and
`node bin/garda.js bootstrap --destination garda-agent-orchestrator`. The
subsequent release command still enforces actual embedded parity; neither
bootstrap nor a static readiness pass certifies the public release candidate.

The release cut requires a successful `Security` workflow run for the exact
candidate commit. Its npm job installs the complete lockfile graph with
lifecycle scripts disabled. Installation and audit explicitly include production,
development, optional, and peer dependencies and use `https://registry.npmjs.org`.
The audit reads the lockfile only, rechecks the pinned npm CLI version, and blocks
high or critical advisories. Candidate `.npmrc` settings cannot omit those types
or redirect the advisory registry. See npm's [include/omit contract](https://docs.npmjs.com/cli/v11/commands/npm-audit/#include).
The pinned OSV reusable workflow scans `package-lock.json` with
`fail-on-vuln: true`. The release-only evidence command checks the workflow
contract, the required successful job steps, the run and job identities, and
freshness. Ordinary offline `quality` remains unchanged.

After the release candidate manifest and tarball exist in a clean checkout of
the intended commit, and the matching Security run has completed, create the
local evidence record. Use the absolute candidate directory, exact tarball
name and SHA-256, repository, and GitHub Actions run ID:

```powershell
node scripts/release-security-evidence.cjs attest <absolute-candidate-dir> <commit-sha> <tag> <tarball-sha256> <tarball-name> <owner/repo> <security-run-id>
```

This writes `security-evidence.json` beside `candidate-manifest.json` and the
candidate tarball. Record its printed SHA-256 in the release handoff. Before a
GO decision, revalidate it against the exact candidate and authenticated live
GitHub run/jobs data:

```powershell
node scripts/release-security-evidence.cjs verify <absolute-candidate-dir> <commit-sha> <tag> <tarball-sha256> <tarball-name> <owner/repo>
```

The command rejects missing, altered, failed, skipped, foreign, or older-than-24h
evidence; a new exact-commit scan is needed after expiry. A candidate made from
another commit or with different tarball or lockfile bytes cannot reuse the
record. The Security run ID is obtained from GitHub Actions, and `gh` must be
authenticated with read access to that repository. Local evidence is a
candidate-bound verification record, not a claim that the candidate tarball
itself was scanned. The explicit candidate GO/NO-GO check consumes this record; the final release boundary also requires the complete operator handoff.
## Public artifact integrity and provenance policy

The npm package is the supported install surface. Its registry integrity and
verified npm provenance are the baseline; a second custom signing system is not
required. A checksum identifies bytes but does not authenticate their author.
Provenance links a package to its source/build identity and does not establish
that the code is safe. Operators must record the exact version, commit, artifact
digest and verification result rather than assuming all releases are attested.
See npm's [provenance verification guide](https://docs.npmjs.com/viewing-package-provenance/).

| Surface | Verification and current limitation |
| --- | --- |
| Published npm tarball | Check `dist.integrity` against the downloaded tarball and verify registry signatures/provenance. Inspect the attestation's repository, commit and publishing workflow against the release handoff. |
| Local `npm pack` candidate | Record SHA-256 of the exact `.tgz` produced after release preflight. A local pack has no npm attestation and is not proof that those bytes were published. |
| Clean source archive | Run `npm run archive:source` from a clean checkout of the intended commit, then record its SHA-256 and that commit. The archiver reads working-tree bytes of tracked paths, not a Git commit object. This is a source snapshot, not an installable npm package or an automatically signed artifact. |
| Evidence archive | Use `npm run archive:evidence`; record its SHA-256 and inspect `ARCHIVE-MANIFEST.json`. The embedded per-entry digests describe selected content, not an external signature or an atomic snapshot of a changing workspace. |
| Git release tag | Resolve `v<version>` to the expected commit with `git rev-parse "v<version>^{commit}"`. `git verify-tag` authenticates only a signed annotated tag with a separately trusted key; unsigned/lightweight tags must be reported as unsigned. |
| Additional release assets | If distributed, list each exact filename, byte size and SHA-256 in the release handoff or an accompanying `SHA256SUMS` file. State whether that list is authenticated. GitHub-generated archives and project-generated archives may contain different bytes. |

### Verify the public npm package

Use an exact released version, not a moving dist-tag. In a scratch directory,
download the public tarball and compare its SHA-512 SRI to registry metadata:

```powershell
$releaseVersion = '1.4.3' # Replace with the release being inspected.
$packageSpec = "garda-agent-orchestrator@$releaseVersion"
$metadataJson = npm view $packageSpec dist --json --registry=https://registry.npmjs.org
if ($LASTEXITCODE -ne 0) { throw 'Cannot read public package metadata.' }
$metadata = $metadataJson | ConvertFrom-Json
if (-not $metadata.integrity -or -not $metadata.tarball) { throw 'Missing integrity or tarball metadata.' }
$tarballPath = Join-Path (Get-Location) "garda-agent-orchestrator-$releaseVersion.tgz"
Invoke-WebRequest -Uri $metadata.tarball -OutFile $tarballPath -ErrorAction Stop
$sha512 = [System.Security.Cryptography.SHA512]::Create()
$stream = [System.IO.File]::OpenRead($tarballPath)
try {
    $actualIntegrity = 'sha512-' + [Convert]::ToBase64String($sha512.ComputeHash($stream))
} finally {
    $stream.Dispose()
    $sha512.Dispose()
}
if ($actualIntegrity -cne $metadata.integrity) { throw 'Published tarball integrity mismatch.' }
Get-FileHash -LiteralPath $tarballPath -Algorithm SHA256
```

Registry metadata and a matching digest alone do not prove publisher identity.
In a fresh scratch npm project, install the exact registry version with scripts
disabled, then verify the installed package's signatures and attestations:

```powershell
npm init --yes
if ($LASTEXITCODE -ne 0) { throw 'Cannot initialize verification project.' }
npm install --ignore-scripts --no-audit --save-exact $packageSpec --registry=https://registry.npmjs.org
if ($LASTEXITCODE -ne 0) { throw 'Cannot install the exact public package for verification.' }
npm audit signatures --registry=https://registry.npmjs.org
if ($LASTEXITCODE -ne 0) { throw 'Registry signature or attestation verification failed.' }
```

Inspect the version's npm provenance view as well: record the attested source
commit and workflow and compare them with the intended release. A successful
signature check is not evidence that a missing provenance attestation exists.
If attestation evidence is absent or unavailable, report that limitation and do
not label the release provenance-verified. npm documents automatic provenance
for supported [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
flows; the observed public artifact remains the evidence for a specific release.

### Record archive and release handoff evidence

For a source archive, first verify that `git rev-parse HEAD` is the intended
release commit and `git status --porcelain` has no output. Keep the checkout
unchanged during archiving. A dirty source snapshot must be identified as such
and cannot be claimed to contain exactly the recorded commit's bytes.

Evidence archives also contain local runtime evidence, so a commit alone does
not identify all their contents. Stop writers while collecting them and record
the manifest and archive digest separately. Use the existing archive commands
and their printed `ArchivePath` values. Hash exact files without rebuilding them:

```powershell
Get-FileHash -LiteralPath '<ArchivePath or packed .tgz path>' -Algorithm SHA256
```

On Linux, `sha256sum <artifact>` computes the same digest; on macOS use
`shasum -a 256 <artifact>`. Compare with the expected digest from the chosen
trusted handoff. A checksum downloaded alongside an unsigned asset detects
accidental corruption but supplies no independent publisher authentication.
The archive manifest can be inspected with
`tar -xOf <archive.tar> ARCHIVE-MANIFEST.json`; its regular-file hashes use
SHA-256 and symlink hashes cover `symlink:<link-target>`.

Before calling a release verified, record:

- Exact version, repository, commit and tag identity, including tag signing status.
- Exact filenames, byte sizes and digests of the candidate and distributed artifacts.
- npm integrity comparison and signature/provenance results for the public version.
- Attested commit/workflow comparison, or an explicit missing/unavailable result.
- Any archive or release-asset signing limitations.

This policy adds documentation and manual release checks only. It does not add
an online dependency to local/offline development, alter update trusted-source
rules, or replace `npm pack`, `archive:source`, `archive:evidence` or
`release:preflight`. The current publish workflow rebuilds before staging;
candidate-to-published byte equality must be checked, not inferred. It does not
currently generate detached signatures or a public `SHA256SUMS` asset. Automated
pack-once publishing and candidate-bound evidence remain separate release work.

## 1.4.4

- [x] Root package metadata, both lockfile version fields, `VERSION`, and the package-surface baseline identify `1.4.4`.
- [x] The changelog describes Garda Compact first, followed by navigation, review, recovery and update improvements, while preserving previous release notes.
- [x] Product links use `https://garda-studio.com/products/cli`; repository and trusted Git update URLs use `Garda-Studio/garda-agent-orchestrator`.
- [x] Update availability is advisory, uses the shared daily cache, keeps terminal notices in English, and includes the UI language catalogs and an explicit manual check.
- [x] Package-surface growth was inspected before its explicit baseline refresh; production dependencies, install hooks and configured growth limits are unchanged.
- [x] The local validation record and its limitations are documented in the source-only audit `docs/release-audit-1.4.4.md`. Static readiness does not certify a public release.

The operator authorized local checks and a push to `dev` after implementation,
independent reviews and those checks are complete. Tagging, publication, and live
GitHub release certification are outside this run. The existing Trusted Publishing
path through `publish.yml` and the `npm-release` environment remains unchanged;
verify its repository identity in npm before any future publish after the repository
transfer. The historical `Shubchynskyi` publisher configuration below is not evidence
that the new repository owner has been configured.

Before a public release, obtain the required clean-candidate, supported-platform,
CI and Security evidence and a separate GO decision. After npm-side staged approval,
verify the public artifact and `npx --yes garda-agent-orchestrator@1.4.4 --version`.

## 1.4.3

- [x] Package metadata is aligned to `1.4.3` in `package.json`, `package-lock.json`, `VERSION`, and the tracked package-surface baseline.
- [x] The changelog adds a patch-release section without changing prior release notes.
- [x] Deployed workspace validation requires compiled `dist/src` runtime paths instead of the intentionally unpublished TypeScript source tree; compiled-only packaging remains unchanged.
- [x] Regression coverage includes real packed installation, setup, successful verification, and rejection of a missing deployed runtime entrypoint.
- [x] The release pipeline retains full tests, coverage, lint, type checks, and packed-package validation without bypassing release gates.

Publication uses the existing tag-driven workflow and npm staged approval with maintainer 2FA. No production dependencies, consumer install scripts, or CI safety controls are changed.

Before creating the new tag, the release commit must pass the clean-tree `npm run release:preflight`. This static checklist records the release scope, not a substitute for that execution evidence.

After npm-side staged approval, verify npm `latest`, integrity/provenance visibility, and `npx --yes garda-agent-orchestrator@1.4.3 --version`.

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

### Full-suite coverage aggregation

`npm run release:preflight` runs the full coverage proof through the installed c8
version. The package's `c8.merge-async` setting merges every V8 coverage report
incrementally to avoid retaining all raw reports in memory at once. It preserves
the configured coverage thresholds, include/exclude rules, uncovered-file
accounting and test-shard controls; it does not increase the Node heap limit.
Keep the original exit code and raw reports when a run fails. A separately
recovered coverage report does not turn a failed full test run into a pass.

### Offline package-surface contract

`npm run validate:package-surface` is the final `release:preflight` step. It builds
the publish runtime, materializes the same legacy compatibility document used by
`prepack`, creates a real `npm pack --json --ignore-scripts` tarball, reads its
contents, and installs that exact archive locally with `--offline --ignore-scripts`.
It neither contacts Socket nor requires a Socket token or any other release-scoring network
service. The current deterministic JSON artifact is written to the gitignored
`garda-agent-orchestrator/runtime/release/package-surface-current.json` path.

The tracked reference is
`config/release-package-surface-baseline.json`. The comparison contract is:

- `fileCount` and `unpackedSizeBytes` may grow only by the numeric allowances in
  the baseline. `installedSizeBytes` covers the offline `node_modules` tree,
  including dependency packages and generated bin shims, and is measured from the offline installation
  and has its own 256 KiB growth allowance. The default file allowance is 10.
- Production dependency count includes direct, optional, and peer dependencies.
  Required package metadata (`description`,
  author, license, module type, repository, homepage, bugs, funding, bin targets,
  and engines) must match
  the reviewed baseline. The packed `package.json` supplies these values.
- npm lifecycle scripts are recorded as a sorted name-to-command map. Any add,
  removal, or command change fails the comparison.
- New executable paths (mode or shebang), minified JavaScript/CSS artifacts,
  and concrete URL hosts in packed text fail until reviewed into the baseline. Declared bin
  targets and their compiled CLI counterparts are known executable paths.
- executable `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, and `.mts` files are scanned
  for the lexical signals `child_process`, `exec`/`execFile` variants, `fetch`,
  `node:fs` or `fs.` use, `readFile` variants, and `writeFile` variants. The
  baseline allows no unreviewed signal-count growth.
- Each packed file and the exact generated tarball has a SHA-256 digest in the
  current artifact and tracked baseline. A changed existing file or removed
  file fails comparison; a tarball byte change with identical packed files also
  fails. Every new packed path fails comparison even within the file and byte
  growth allowances, until it is reviewed into the baseline. The sorted
  packed path, size, and SHA-256 manifest is bound by a separate SHA-256 digest.
  npm's file report must match the tarball byte
  for byte on path and size before any metric is accepted. The archive is
  generated in a temporary directory and removed after measurement. An
  explicitly supplied prior artifact can replace the baseline with
  `--prior-artifact <path>` and uses the conservative default growth allowances.

Raw npm tar archives can differ across hosts even when all packed file bytes
match: Windows npm can encode a declared CLI launcher as `0644`, while POSIX
encodes it as `0755`. The tracked baseline can contain a
`tarballSha256ByPlatform` map of independently audited exact archive digests.
The default `npm run release:preflight` selects only the current Node platform's
digest, while every platform shares the same packed-file hashes, manifest,
metadata, security metrics, and growth allowances. An unlisted platform fails
closed; another platform's digest or an unapproved archive is never accepted.
Legacy baselines without this map retain their single exact digest comparison.

To enroll another platform, inspect its real packed artifact against the
canonical baseline, including tar header modes, file hashes and security
metrics, then commit only its independently approved digest and audit rationale.
Preserve the initial rejection and both artifacts in the local audit. An
artifact from a failed comparison is not automatically an approved reference.
An explicit `--prior-artifact <path>` still compares that exact archive and does
not select platform alternatives.

These lexical counts are review prompts, not vulnerability findings. A failure
means inspect the package diff; it does not assert that the matched code is
unsafe. For intentional growth, refresh the tracked baseline only with the
explicit audited command and commit the rationale with the resulting diff:

```powershell
node scripts/node-foundation/build-scripts.cjs validate-release.js package-surface-baseline --confirm-baseline-update --rationale "Describe the reviewed package growth"
```

The command never silently updates the baseline: both the confirmation flag and
a non-empty rationale are mandatory. A refresh records only the measured host's
digest and drops older platform digests; approve fresh archives on other hosts
before enrolling them again. External Socket scores remain advisory and
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
