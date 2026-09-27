# Update Runtime Handoff

When `check-update --apply` replaces the deployed bundle, the CLI runs the fixed
entrypoint from that bundle in a fresh Node process. The parent retains the update
lock until the child returns. Both processes must agree on the target root, local
host, parent process, lock generation, acquisition time and owner-file identity.
An unbound, replaced or released owner is rejected before update mutations.
Before spawning the child, the parent also rejects ownership acquired before its
own process started, so a reused numeric PID cannot revive an older owner file.

The handoff travels through the child's standard input. A legacy caller may omit
the internal `lifecycleLockAlreadyHeld` boolean when invoking the current CLI
runner; the runner captures the real held lock independently. The boolean alone
does not authorize the production child entrypoint.

Before constructing rollback data, the child rechecks the inherited owner. The
pre-sync backup must still belong to that update generation and match the sentinel,
sync plan, contained backup paths and original VERSION. Existing rollback validation
and source-trust checks continue to apply.

Git update staging uses independently bound clone and template directories.
Cleanup attempts both directories, preserves their failures together, and retains
the primary update error if cleanup also fails. An ambiguous path is never deleted
by rebinding it to a replacement directory.
