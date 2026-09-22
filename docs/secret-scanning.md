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

The GitHub Actions workflow `.github/workflows/secret-scanning.yml` runs
gitleaks automatically on:

- every push to `main`, `master`, `dev`, and `release/**` branches;
- every pull request targeting those branches;
- a weekly schedule (Monday 04:00 UTC);
- manual `workflow_dispatch`.

The workflow checks out the full commit history with `fetch-depth: 0`, downloads
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
gitleaks detect --source . --config .gitleaks.toml --verbose
```

This scans the entire Git history. On first run it may take a few seconds
depending on repository size.

### Scan only staged changes (pre-commit)

```bash
gitleaks protect --source . --config .gitleaks.toml --staged --verbose
```

Use this before committing to catch secrets early.

### Scan a specific commit range

```bash
gitleaks detect --source . --config .gitleaks.toml --log-opts="HEAD~5..HEAD"
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | No leaks detected. |
| `1`  | One or more leaks detected. |
| `2`  | Usage or configuration error. |

## Configuration

The repository-level configuration lives in `.gitleaks.toml` at the
repository root. It extends the gitleaks built-in ruleset (AWS keys, GCP
credentials, GitHub/GitLab tokens, generic high-entropy secrets, private
keys, and more) with project-specific allowlists:

- **Generated runtime artifacts and narrow known fixtures** — paths under
  `runtime/`, `garda-agent-orchestrator/runtime/`, `.node-build/`,
  `node_modules/`, `testResults.xml`, and the intentional
  `tests/node/core/redaction.test.ts` fixture are excluded.
- **Placeholder tokens** — lines matching patterns like `EXAMPLE_TOKEN`,
  `changeme`, or `dummy` are suppressed.

### Adding an allowlist entry

If gitleaks flags a legitimate false positive, add an entry to the
`[allowlist]` section in `.gitleaks.toml`:

```toml
# Suppress a single known-safe fixture path
paths = [
  '''tests/node/my-fixture.test.ts''',
  '''my-new-fixture/.*''',
]
```

Or suppress a specific pattern:

```toml
regexes = [
  '''MY_KNOWN_SAFE_PATTERN''',
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
    rev: v8.21.2
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
| False positive on a placeholder | Add the regex to `[allowlist].regexes` in `.gitleaks.toml`. |
| `gitleaks` not found | Install gitleaks (see above) or run via Docker: `docker run --rm -v "$(pwd):/repo" zricethezav/gitleaks detect --source /repo --config /repo/.gitleaks.toml`. |
| CI job fails unexpectedly | Check the install checksum and scan logs; confirm the pinned version/SHA pair and `.gitleaks.toml` path match the workflow. |
