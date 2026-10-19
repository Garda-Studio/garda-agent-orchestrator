# Current-task test selection beside an approved owner

Task-scoped `workflow set --task-id ... --reason ... --full-suite-command ...
--focused-required-test-path ...` accepts a current task beside a preserved active
owner when native task entry already recorded operator approval for the exact
owner cycle and the declared file scopes remain disjoint.

The selector reuses the existing implementation-ownership guard. Missing approval,
restarted owners, physical file aliases and runtime owners missing from the
canonical queue remain blocking. It does not change the generic operator
confirmation time limit or grant access to any other setting.

Audit publication rechecks the current task, worktree, selected test bytes and
owner approval. The global audit retains every active task and binds the command
change to each current cycle; the task-specific selection authority still names
only the selecting task. Existing workflow compatibility consumers can therefore
refresh command evidence without replacing frozen policy or held source history.

Regression coverage executes native entries for both tasks, verifies unchanged
held source, queue and task-mode artifacts, exercises command-only compatibility
for both cycles, and rejects orphan owners, physical overlap and a restarted
owner before prepared selection or audit publication can authorize a write.
