# Package-surface integration reference

The offline package integration test now creates its own explicit same-host
baseline for the positive baseline validation case. Ordinary development changes
can differ from the last independently audited release archive, and a host can
lack an approved platform digest. Neither condition is implicit release approval.

The test still invokes default baseline selection, verifies the exact checked-in
reference and platform digest, requires rejection of archive or manifest drift,
and checks that the release baseline bytes remain unchanged. Production package
comparison, growth limits and the separate release preflight gate are unchanged.
