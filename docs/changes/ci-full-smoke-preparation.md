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
