# Windows native authority and helper environment

Hosted Windows creates ordinary fixture directories and files with explicit
SYSTEM, Administrators and current-user ACEs. Rejecting every explicit write ACE
therefore rejected otherwise trusted timelines. Explicit writes are now accepted
only for those three native SID authorities; inherited and deny-only behavior is
unchanged. Other explicit writers, including Everyone, remain rejected.

The fast ACL path resolves canonical trusted account names once from native token
and SID APIs. It requires exact ASCII principals and the expected icacls layout;
ambiguous, localized or lossy text falls back to native SID inspection. Permission
tokens are checked throughout special-permission lists, including `RD,WD`.
Metadata cache invalidation and all file identity/link/containment checks remain.

The Windows process terminator previously received only SystemRoot and temporary
paths. On hosted runners that environment hung for more than ten seconds, while
the same native helper with an ordinary environment completed in about 1.3 seconds.
Native helpers now receive an OS-backed user profile and private cache locations,
trusted System32 tool/module paths and command processor. Mutable inherited
profile, PATH and PowerShell module paths are ignored. Temporary paths retain
their existing bounded forwarding contract.

Process creation windows, native handles, target ownership, helper timeouts and
shutdown budgets are unchanged. No PID-only fallback or broader ACL grant is
introduced. A real explicit trusted-ACL RED precedes the repair; native tests also
verify rejection after an Everyone write grant and hostile environment isolation.
