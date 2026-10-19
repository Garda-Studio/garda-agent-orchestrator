# Standalone Windows source identity

The offline publication-history guard now reconstructs an omitted Windows path
volume id through a second live descriptor while its original read descriptor
remains open. This standalone pre-build guard retains exact descriptor device
and inode comparisons, checks path metadata again, and verifies native path
stability. A matching inode on a different descriptor volume remains rejected.
Reviewed source digests, no-symlink rules and all remote history and publication
authorization checks are unchanged.

The startup alias regression also creates its parent with a native physical
path. Windows Node 22's loader can retain a DOS alias in its module-cache path;
the test now isolates the intentional junction under a physical parent.
