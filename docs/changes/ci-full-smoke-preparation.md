# Cross-platform smoke preparation

The full manual CI smoke matrix exposed two harness defects. On macOS, the
temporary package root can be a symbolic path while Node's module cache uses
its real path. The startup probe now resolves the package root before counting
modules; dispatch loading and lazy version/help assertions remain mandatory.
A focused alias regression covers loaded and unloaded dispatch states.

Both smoke workflow entrypoints now complete ordinary agent initialization
before attempting an update. Their synthetic project has a real syntax-check
build and explicit project facts. The shared CI-only preparation helper invokes
the real agent-init CLI and requires its readiness result. Production update
admission, initialization checks and protected-state writers are unchanged.

The subsequent native macOS run reached packaged setup and exposed the same
temporary-directory alias at the deployment boundary. Newly created packaging
and workflow workspaces now use physical paths before setup. Production
symlink/junction rejection stays enforced; only synthetic caller paths change.
The same filesystem canonicalization expands Windows short-name temporary roots
before the update rollback boundary compares them with native physical paths.
The workflow exports that physical temp root through TMPDIR, TEMP and TMP so
update's own temporary clone and journal paths use the same host identity.
Windows release validation publishes the same physical temp identity before
running its tests; protected timeline paths must not inherit DOS aliases.
These callers use fs.realpathSync.native: the JavaScript realpath implementation
preserves Windows DOS short names, while native realpath expands them.

Windows Node 22 plan inspection also uses the existing authenticated file-stat
helper at both path reads. Older path stat APIs can omit the volume id returned
by descriptors; the helper reconstructs that identity without making device zero
a wildcard. The owning Windows regression and existing bounds/link/race checks
cover this consumer.
