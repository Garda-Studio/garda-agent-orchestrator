# Secret Scanning

This repository uses [gitleaks](https://github.com/gitleaks/gitleaks) to
detect accidentally committed secrets such as API keys, tokens, and private
keys. Secret scanning is a **prevention** layer that complements the runtime
redaction implemented in `src/core/redaction.ts` in source checkouts and applied
to diagnostics and artifacts.

## How It Works

| Layer | Purpose |
|---|---|
| **Secret scanning (this doc)** | Prevents secrets from entering the repository. |
| **Runtime redaction (T-014)** | Sanitises secrets that reach diagnostics/artifacts at runtime. |

Together the two layers form a defence-in-depth approach: scanning stops
secrets at the source while redaction limits exposure if a secret slips
through.

## CI Integration

The GitHub Actions workflow `.github/workflows/secret-scanning.yml` accepts only
an explicitly authorized `workflow_dispatch`. Supply the exact repository and
full lowercase run commit SHA, type `I authorize this selected run`, and select
`gitleaks`, `ubuntu-latest` and Node `24`. The explicit `all` choice maps to that
same single-job Linux set. Repository, SHA and authorization have no defaults.
The shared selector rejects foreign or malformed inputs before scanning; a failed
or cancelled authorization prevents the scan. See [manual selection](manual-ci.md).

The workflow checks out the exact run SHA without persisting Git credentials,
retains the full commit history with `fetch-depth: 0`, downloads
Gitleaks CLI v8.30.1, verifies the release archive against its pinned SHA-256
digest, and runs `gitleaks git` with `.gitleaks.toml`. The scan uses redacted
output and exits with status 1 when a leak is found.

## Local Usage

### Install gitleaks

```bash
# macOS (Homebrew)
brew install gitleaks

# Windows (Scoop)
scoop install gitleaks

# Windows (Chocolatey)
choco install gitleaks

# Linux (snap)
sudo snap install gitleaks

# Go install (any platform with Go ≥ 1.22)
go install github.com/gitleaks/gitleaks/v8@latest

# Or download a pre-built binary from:
# https://github.com/gitleaks/gitleaks/releases
```

### Run a full-repository scan

```bash
gitleaks git --config .gitleaks.toml --redact .
```

This scans the entire Git history. On first run it may take a few seconds
depending on repository size.

### Scan only staged changes (pre-commit)

```bash
gitleaks git --config .gitleaks.toml --redact --pre-commit --staged .
```

Use this before committing to catch secrets early.

### Scan a specific commit range

```bash
gitleaks git --config .gitleaks.toml --redact --log-opts="HEAD~5..HEAD" .
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | No leaks detected. |
| `1`  | One or more leaks detected. |
| `2`  | Usage or configuration error. |

## Configuration

The repository-level configuration lives in `.gitleaks.toml` at the
repository root. Its explicit `[extend] useDefault = true` retains the built-in
ruleset (AWS keys, GCP credentials, GitHub/GitLab tokens, generic high-entropy
secrets, private keys, and more) with project-specific allowlists:

- **Root generated artifacts and one known fixture** — anchored paths under
  `garda-agent-orchestrator/runtime/`, `.node-build/`, and `node_modules/`,
  plus exact root `testResults.xml` and `tests/node/core/redaction.test.ts`,
  are excluded. A project's `runtime/`, nested runtime-like paths, and
  fixture-name lookalikes remain covered.
- Words such as `dummy` or `EXAMPLE_TOKEN` on a line do not suppress an
  otherwise detected secret. Use public placeholders that cannot be credentials.

The inherited default allowlist also excludes dependency paths such as
`node_modules/`. The canary control verifies that exclusion even when its fixture
is tracked in Git; this is not detection coverage inside installed dependencies.

### Local coverage canaries

Use the same pinned Gitleaks version as the workflow. Set `GARDA_GITLEAKS_BIN`
to the verified local executable and run:

```bash
GARDA_GITLEAKS_BIN=/absolute/path/to/gitleaks node scripts/node-foundation/build-scripts.cjs test.js tests/node/repo/secret-scanner-canaries.test.ts
```

The tests create deterministic public canaries in isolated temporary directories,
exercise directory scanning and local Git-history scanning, require detection in
source/scripts and nested runtime-like paths, and compare the project exceptions
with a default-rule Git control while retaining its built-in dependency exclusion.
Reports are redacted; no issued credentials,
network access, or CI dispatch is involved. Without this explicit local tool
input, these integration tests report a dependency skip. An invalid supplied
path/version or missing detection fails the tests. A skip is not scanner coverage.

For directory scanning, run `gitleaks dir --config .gitleaks.toml --redact .`
from the repository root so the root-relative allowlist has the same path contract
as Git-history scanning.

### Adding an allowlist entry

If gitleaks flags a legitimate false positive, add an entry to the
`[allowlist]` section in `.gitleaks.toml`:

```toml
# Suppress a single known-safe fixture path
paths = [
  '''^tests/node/my-fixture\.test\.ts$''',
]
```

Keep allowlist entries minimal and document the reason for each suppression.

## Pre-commit Hook (Optional)

To enforce scanning automatically before every commit, add gitleaks to a
[pre-commit](https://pre-commit.com/) configuration:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.30.1
    hooks:
      - id: gitleaks
```

Then install the hook:

```bash
pre-commit install
```

## Troubleshooting

| Symptom | Action |
|---|---|
| False positive on a test fixture | Add the path to `[allowlist].paths` in `.gitleaks.toml`. |
| False positive on a placeholder | Use an unmistakably public placeholder; justify any precise exception without suppressing whole lines by fixture labels. |
| `gitleaks` not found | Install gitleaks (see above) or run via Docker: `docker run --rm -v "$(pwd):/repo" -w /repo zricethezav/gitleaks:v8.30.1 dir --config .gitleaks.toml --redact .`. |
| CI job fails unexpectedly | Check the install checksum and scan logs; confirm the pinned version/SHA pair and `.gitleaks.toml` path match the workflow. |
