# Incomplete Workspace Diagnostics

## Project Memory Bootstrap

When project-memory templates are missing, bootstrap reports the missing seed files.
It preserves existing user-owned memory and does not invent replacement content.
If required memory files remain absent, `agent-init` reports an incomplete bootstrap,
`ProjectMemoryInitialized: false`, `ProjectMemoryValidated: false`, and a workspace
that is not ready for tasks. A dry run reports missing templates without creating
the live memory directory.

Restore the missing templates from a trusted Garda installation and rerun
`agent-init` with the required project setup checkpoints. Keep existing project
memory intact; bootstrap only adds missing seed files.

## Workspace Verification

`verify` returns failed diagnostics for an empty or incomplete workspace. Errors
from skill validation are included in the skill-pack and skills-index contract
violations instead of terminating verification before its report is produced.
If skill validation throws, subsequent skill checks are not attempted.

Links, dangling links, and files used where directories are required remain
invalid. Diagnostic conversion does not make an unsafe path valid or weaken the
strict skill-listing and contained-filesystem APIs.
