# Windows runtime fixture and remaining native diagnosis

The catalog reconciliation fixture still matched only the short `icacls.exe`
command after production ACL inspection changed to a protected absolute path.
Its replacement never executed. A focused RED control observed zero fixture
inspections instead of one. Matching the same native system-directory command
restores the intended unit fixture and leaves unrelated commands untouched.
The full local Windows24 suite passes 46 cases in 66 seconds, compared with
45 cases in 560 seconds before the correction. Real native ACL acceptance lives
in its separate owning suites; this unit fixture is not native ACL evidence.

Full Windows22 also failed the adversarial-PATH descendant cleanup and concurrent
review publication timing cases. Both pass locally on Windows24, which does not
qualify Windows22. The diagnostic-only Release entry now selects exactly these
two failed cases with read-only native invocation tracing. Previously accepted
baseline probes remain available explicitly through `--baseline-controls`.

The preload preserves native executable paths, arguments, environment, timeouts,
callback results and production identity checks. It reports bounded invocation
status, timing, target creation windows and script digests without environment
values. After an unsuccessful helper it may read the recorded root process
creation time; that separate observation cannot terminate a process and is not
acceptance evidence. The diagnostic command has a 180-second outer limit and
retains the actual selected test result. Full Release remains mandatory.
