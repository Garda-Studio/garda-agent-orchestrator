# Windows cancellation and failed-case diagnostics

Cancellation now clears the command deadline while its existing managed-process
cleanup completes. A slow native cleanup must not change an already cancelled
result into a timeout. The streamed and shell paths have delayed-cleanup controls
that fail before this repair. Process identity checks and cleanup budgets are
unchanged; this does not by itself resolve the hosted native helper failures.

The diagnostic selects only unresolved cases from full run 39264167087. Node 22
checks UI timeout cleanup and the compact cancellation case in its quiet failed
shard. Node 24 checks compact cancellation and six failed native termination cases.
Previously successful Node 22 core and Node 24 UI cases are omitted.

The preload installs observers only in compiled test workers. Ordinary Node child
commands retain their original stdout and stderr; diagnostic startup output must
not cause premature cancellation or corrupt payload assertions. Native helper
arguments, environment, creation-window checks, callbacks and production timeouts
remain unchanged. Failed helper observations are read-only, may add diagnostic
latency, and never supply termination authority or full Release acceptance.

Individual diagnostic tests have a 90-second bound. The outer bounds cover only
the selected failed cases. Full Windows Release acceptance remains outstanding.
