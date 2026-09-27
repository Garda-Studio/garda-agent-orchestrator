# Working alongside an unfinished task

Garda reports unfinished implementation owners before starting another task in
the same worktree. Ask the operator to confirm proceeding while preserving the
existing changes. A dirty working tree does not require a separate worktree.

After confirmation, use the `enter-task-mode` command supplied by `next-step`:
add one `--allow-active-task <id>` for every reported owner, provide
`--operator-confirmed yes` and the current confirmation timestamp through
`--operator-confirmed-at-utc`, and declare the new task's files with repeated
`--planned-changed-file` arguments. Do not claim operator confirmation before
it has been given.

The task-mode event records the approval and binds it to the receiving task's
artifact and the approved owners' task-mode artifacts. Subsequent gates reuse
that approval. A newly active owner, a restarted owner, or a changed receiving
artifact requires confirmation again. Missing or invalid owner evidence cannot
be approved through this flow.

The receiving task's planned files must not overlap an unfinished owner's
planned scope. This includes containing directories and alternate paths to the
same file. Confirmation does not grant shared ownership of those files.

Re-entering alongside active owners requires fresh confirmation. Task-mode
re-entry automatically preserves its original dirty-workspace baseline, even
without `--upgrade-existing-task-mode`, when writing a different artifact path,
or after every previously approved owner has completed. Later unrelated changes
cannot become accepted baseline state through re-entry.

Existing changes outside the new task's scope remain protected by the captured
dirty-workspace baseline. The approval does not complete, reset, or discard the
unfinished tasks, and does not skip their validation or review gates.
