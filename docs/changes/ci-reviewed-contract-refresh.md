# Reviewed CI source contract refresh

The complete-suite evidence verifier pins the full CI workflow after normalizing
CRLF to LF. The smoke onboarding and native temporary-path repairs changed that
workflow, so Release validation rejected its own reviewed source before reaching
CI history checks.

The refreshed pin covers only the previously reviewed delta from `e18564f1`:

- Windows Release checks receive native physical `TEMP`, `TMP` and `TMPDIR` paths.
- Smoke workspaces use native physical temporary roots on each platform.
- The synthetic smoke project has a real syntax-check build and completes normal
  agent initialization before update through the shared fixture helper.

Manual dispatch, exact repository and commit authorization, job selection, the
22-variant matrix, runner families, runtime versions, required validation steps,
read-only permissions and pinned Actions remain unchanged. The selector and npm
script digests are unchanged. Full workflow bytes remain pinned, including
comments and executable scalars; only CRLF normalization is allowed.

Existing release-readiness controls exercise legitimate workflows and CRLF,
source drift, weakened scripts, missing authorization, skipped jobs, incomplete
history and failed or foreign attempts. This refresh does not authorize a
publication or convert earlier CI runs into validation of a later commit.
