# Focused Windows helper environment diagnosis

The repaired native ACL boundary passes on both hosted Windows runtimes. The
PowerShell helper still compiles only with the inherited runner environment;
adding OS-backed profile paths alone did not resolve that hosted failure.

The existing failed-job probe now compares bounded environment groups only when
the exact production helper fails its empty-target compilation and the inherited
environment succeeds. Every experiment uses the same trusted executable and
script with an empty target list. It logs environment names, statuses and bounded
compiler output, never arbitrary environment values. At most twenty experiments
run, each with the existing ten-second diagnostic timeout.

This observation does not alter the production helper, its environment, native
process identities, permissions or shutdown budgets. Diagnostic jobs continue to
skip required full Release validation and cannot provide full acceptance.
