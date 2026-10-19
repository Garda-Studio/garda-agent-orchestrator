# Command Reference Appendix

Primary entry point: selected source-of-truth entrypoint for this workspace.

This appendix is optional reference material for the compact command policy in
`40-commands.md`. Load it only when exact tool-specific command variants are
needed. Mandatory lifecycle gates and mandatory rule-pack loads should keep
using `40-commands.md` without this appendix.

## Version Control (git)

| Instead of | Prefer | Use case |
|---|---|---|
| `git diff` | `git diff --stat` | Scope overview |
| `git diff` | `git diff -- path/to/changed-file` | Targeted inspection |
| `git log` | `git log --oneline -n 20` | Recent history |
| `git log --all` | `git log --oneline --graph -n 30` | Branch topology |
| `git status` | `git status --short --branch` | Quick state |
| `git show <sha>` | `git show --stat <sha>` | Commit overview |
| `git stash list` | `git stash list --oneline` | Stash summary |

## Testing

| Tool | Compact flags | Notes |
|---|---|---|
| pytest | `-q --tb=short --no-header` | Add `--tb=long` only for failing test investigation |
| jest / vitest | `--silent` or `--verbose=false` | Default reporters are noisy |
| go test | `-count=1 -short` | Add `-v` only for specific test debug |
| cargo test | `-- --format=terse` | Terse hides passing tests |
| dotnet test | `--verbosity quiet` | Use `normal` on failure |
| phpunit | `--no-progress --compact` | Suppress per-test dots |

## Package Managers

| Instead of | Prefer | Saves |
|---|---|---|
| `npm install` | `npm install --prefer-offline --no-fund --no-audit` | Suppresses advisory noise |
| `npm ls` | `npm ls --depth=0` | Top-level deps only |
| `npm ls` (programmatic) | `npm ls --json --depth=0` | Structured, agent-friendly |
| `pip install -r req.txt` | `pip install -q -r req.txt` | Quiet progress bars |
| `pip list` | `pip list --format=columns` | Compact table |
| `yarn install` | `yarn install --silent` | No progress |
| `composer install` | `composer install --quiet` | No progress |

## Build, Lint, And Type-Check

| Tool | Compact flags |
|---|---|
| tsc | `--noEmit --pretty false` |
| eslint | `--format=compact` |
| eslint (programmatic) | `--format=json` |
| dotnet build | `--verbosity quiet` |
| gradle | `-q` or `--console=plain` |
| mvn | `-q` (quiet) or `-B` (batch non-interactive) |
| cargo build | `--message-format=short` |

## Search And File Inspection

| Instead of | Prefer | Reason |
|---|---|---|
| `grep -r <pat> .` | `grep -rl --max-count=5 <pat> src/` | Files only, bounded, scoped |
| `rg <pat>` | `rg -l --max-count=5 <pat> src/` | Files only, bounded, scoped |
| `rg <pat>` with context | `rg -C2 --max-count=10 <pat> src/` | Limited context, bounded |
| `cat <large-file>` | `head -n 60 <file>` or `tail -n 60 <file>` | Targeted region |
| `find . -name "*.<ext>"` | `find . -name "*.<ext>" -not -path "*/<dependency-or-build-dir>/*"` | Exclude dependency and build output (for example `node_modules`, `target`, `bin/obj`, `.venv`) |
| `ls -laR` | `ls -la src/` or `tree -L 2 src/` | Scoped, bounded depth |

## Containers And Infrastructure

| Instead of | Prefer |
|---|---|
| `docker logs <c>` | `docker logs --tail 50 <c>` |
| `kubectl logs <pod>` | `kubectl logs --tail=50 <pod>` |
| `docker ps` | `docker ps --format "table \{{.Names}}\t\{{.Status}}"` |
| `kubectl get pods` | `kubectl get pods -o wide` or `-o json` |
