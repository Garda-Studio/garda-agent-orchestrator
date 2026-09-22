# Branch Protection Guidance

## Overview

The orchestrator enforces **local** protected-path integrity at task
completion time (see [Orchestrator Work and Isolation](orchestrator-work-and-isolation.md)).
GitHub **branch protection rules** and **CODEOWNERS** extend that
enforcement to the **PR-merge** boundary so that changes to critical
paths cannot land without the right approvals, passing CI, and a clean
merge target.

Together the two layers form a defence-in-depth governance model:

| Layer | When | What it guards |
|---|---|---|
| **Local protected-path enforcement** | Task completion gate | Orchestrator control-plane files in the worktree. |
| **CODEOWNERS + branch protection** | Pull request merge | The same files, plus CI workflows, security config, and package metadata. |

## Recommended Branch Protection Settings

Apply these settings to every long-lived branch (`main`, `dev`,
`release/*`) through **Settings → Branches → Branch protection rules**
in the GitHub repository.

### Required Checks

| Setting | Recommended value | Rationale |
|---|---|---|
| **Require status checks to pass before merging** | ✅ Enabled | Prevents merging when CI is red. |
| **Require branches to be up to date before merging** | ✅ Enabled | Ensures the PR branch includes the latest target commits. |
| **Status checks that are required** | Individual job checks listed below | `CI` is a workflow name; there is no aggregate check named `ci`. |

The job names below come from [ci.yml](https://github.com/Shubchynskyi/garda-agent-orchestrator/blob/main/.github/workflows/ci.yml). Select each expanded check reported by a recent pull-request run; `{node}` and `{os}` below describe matrix values and are not literal check names.

| Job check pattern | Required matrix values |
|---|---|
| `Static Checks / Node {node}` | `22.13.0`, `24` |
| `Unit Tests / Node {node}` | `22.13.0`, `24` |
| `Gate Tests / Node {node}` | `22.13.0`, `24` |
| `CLI Tests / Node {node}` | `22.13.0`, `24` |
| `Lifecycle Tests / Node {node}` | `22.13.0`, `24` |
| `Binary Tests / Node {node}` | `22.13.0`, `24` |
| `Release Validation / {os} / Node {node}` | `ubuntu-latest`, `windows-latest`, each on `22.13.0` and `24` |
| `Smoke / {os} / Node {node}` | `ubuntu-latest`, `windows-latest`, `macos-latest`, each on `22.13.0` and `24` |

For example, select `Static Checks / Node 24` and `Release Validation / windows-latest / Node 22.13.0`. GitHub may group these beneath the `CI` workflow in its display. Recheck the actual emitted check names after a matrix or reusable-workflow change; this document does not assert that repository settings already require them.

### Release Security Required Checks

Use the existing security workflows as the release-security baseline; do
not add a duplicate security pipeline for release branches. Label every
retained check as either `blocking` or `informational` so branch
protection and release-readiness diagnostics stay explicit.

| Check | Label | Branch-protection guidance | Rationale |
|---|---|---|---|
| `CI` / release validation matrix | `blocking` | Required | Proves build, test shards, package smoke, release readiness, and lifecycle smoke. |
| `Security / npm audit` | `blocking` | Required | Fails on high or critical dependency advisories, including devDependencies; the workflow does not omit dev dependencies. |
| `Secret Scanning / Gitleaks` | `blocking` | Required | Prevents committed secrets from reaching protected branches. |
| `Security / OSV Vulnerability Scan` | `informational` | Optional required check | Keeps SARIF-backed vulnerability visibility; make it required only when the team accepts upstream advisory noise as merge-blocking. |
| `SBOM / Generate SBOM` | `informational` | Optional required check | Produces the CycloneDX artifact for release evidence; artifact absence is still surfaced by the workflow itself. |

### GitHub Action pinning decision

The GitHub Actions used by the CI and security workflows remain version-tag pinned
(`actions/checkout@v7.0.0`, `actions/setup-node@v6`,
`actions/upload-artifact@v7.0.1`, and
`google/osv-scanner-action/...@v2.3.0`) and are intentionally not SHA-pinned at
this time. Gitleaks is installed as CLI v8.30.1 from its release archive and the
archive is verified against a pinned SHA-256 digest. These choices are an
operator-maintainability tradeoff, not a provenance guarantee.
Release-sensitive operators should review action and CLI update diffs before
broadening branch protection, and this decision does not replace future provenance or release-signing work.

### Update-source policy reporting

Release updates report the update-source trust policy separately from
PR-time branch protection. The readiness baseline expects these statuses
to remain visible:

| Status | Label | Meaning |
|---|---|---|
| `NPM_REGISTRY_INTEGRITY_RECORDED` | `informational` | Preferred npm update path recorded exact package and registry integrity metadata. |
| `TRUSTED_GIT_NO_RELEASE_SIGNATURE` | `informational` | Allowlisted git source passed trust policy, but no release signature was verified. |
| `TRUST_OVERRIDE_UNVERIFIED` | `informational` | Operator override bypassed trusted-source enforcement and must stay local/dev recovery only. |

### Required Reviews

| Setting | Recommended value | Rationale |
|---|---|---|
| **Require pull request reviews before merging** | ✅ Enabled | At least one human or designated reviewer must approve. |
| **Required number of approvals** | `1` (increase for high-risk branches) | Balances velocity with oversight. |
| **Dismiss stale pull request approvals when new commits are pushed** | ✅ Enabled | Forces re-review after changes. |
| **Require review from Code Owners** | ✅ Enabled | Enforces CODEOWNERS approval for protected paths. |

### Merge Restrictions

| Setting | Recommended value | Rationale |
|---|---|---|
| **Require signed commits** | Optional | Useful for supply-chain assurance but may add contributor friction. |
| **Require linear history** | Optional | Keeps the commit graph clean when squash/rebase merge is preferred. |
| **Include administrators** | ✅ Enabled | Prevents admin bypass of protection rules. |
| **Restrict who can push to matching branches** | ✅ Enabled | Limits direct pushes to the CI bot and release automation only. |

### Force Push and Deletion

| Setting | Recommended value | Rationale |
|---|---|---|
| **Allow force pushes** | ❌ Disabled | Protects branch history from rewriting. |
| **Allow deletions** | ❌ Disabled | Prevents accidental branch deletion. |

## CODEOWNERS Integration

The repository includes a `.github/CODEOWNERS` file whose path patterns
mirror the orchestrator's local protected-path list. When **Require
review from Code Owners** is enabled in branch protection, GitHub
automatically requests reviews from the listed owners for any PR that
touches those paths.

### Covered paths

- **Orchestrator runtime** — `runtime/`,
  `garda-agent-orchestrator/runtime/`,
  `live/docs/agent-rules/`,
  `garda-agent-orchestrator/live/docs/agent-rules/`,
  `live/config/`,
  `garda-agent-orchestrator/live/config/`,
  `live/skills/`,
  `garda-agent-orchestrator/live/skills/`
- **Source checkout roots** — `src/`, `garda-agent-orchestrator/src/`,
  `bin/`, `garda-agent-orchestrator/bin/`, `dist/`,
  `garda-agent-orchestrator/dist/`, `template/`,
  `garda-agent-orchestrator/template/`
- **CI workflows** — `.github/workflows/`
- **Security config** — `SECURITY.md`, `.gitleaks.toml`
- **Agent entrypoints** — `.github/copilot-instructions.md`,
  `.github/agents/`, `.agents/`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`
- **Package metadata** — `package.json`, `package-lock.json`,
  `tsconfig*.json`

### Customising owners

This checkout uses `@Shubchynskyi` in `.github/CODEOWNERS`. If you fork
the repository, replace that owner handle with your actual GitHub team
handle or individual user handles. Multiple owners can be listed
space-separated:

```text
src/   @your-org/core-team @your-username
```

## How the Two Layers Complement Each Other

```
Developer workstation          GitHub PR
┌──────────────────────┐       ┌────────────────────────────┐
│ Task agent runs       │       │ PR opened against main      │
│ ↓                     │       │ ↓                           │
│ enter-task-mode       │       │ CI status checks run        │
│ ↓                     │       │ ↓                           │
│ implementation        │       │ CODEOWNERS matched          │
│ ↓                     │       │ ↓                           │
│ completion-gate       │──PR──▶│ Required reviews requested  │
│ (protected-path check)│       │ ↓                           │
│                       │       │ Approvals + checks pass     │
│                       │       │ ↓                           │
│                       │       │ Merge allowed               │
└──────────────────────┘       └────────────────────────────┘
```

The local gate catches accidental control-plane drift **before** the PR
is even created.  Branch protection and CODEOWNERS catch anything that
bypasses or post-dates the local gate.

## Quick Setup Checklist

1. [ ] Confirm `.github/CODEOWNERS` exists and paths are correct.
2. [ ] Confirm the owner handles in `.github/CODEOWNERS` match this
   checkout or your fork's maintainers.
3. [ ] Enable **Require pull request reviews before merging** on target branches.
4. [ ] Enable **Require review from Code Owners**.
5. [ ] Select the expanded CI job checks above, plus the chosen security checks, as **required status checks**; verify their names on a current PR run.
6. [ ] Enable **Dismiss stale approvals when new commits are pushed**.
7. [ ] Enable **Include administrators** to prevent bypass.
8. [ ] Disable **Allow force pushes** and **Allow deletions**.

## Related Docs

- [Orchestrator Work and Isolation](orchestrator-work-and-isolation.md) — local
  protected-path enforcement, `--orchestrator-work` flag, remediation
- [Control-Plane Isolation Mode](control-plane-isolation.md) — sandbox
  execution, manifest drift enforcement
- [Secret Scanning](secret-scanning.md) — gitleaks CI integration
- [SBOM](sbom.md) — supply-chain transparency
- [CLI Reference](cli-reference.md) — gate command surface
