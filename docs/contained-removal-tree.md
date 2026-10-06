# Contained Removal Tree Assertion

`assertBoundContainedRemovalTree(binding, maximumEntries?, retained?)` validates
an existing contained tree without changing it. The tree root counts as one
entry. An omitted or `undefined` entry cap defaults to 4096; an explicit
nonnegative safe-integer cap replaces that default, including a larger cap.
An empty directory therefore requires a cap of at least one.

The default preserves the one-argument call used by captured suspended work,
with bounded directory enumeration. Explicit invalid caps still fail before
enumeration. Containment-root removal, links, shared files, mounted boundaries,
changed path identities and ambiguous previously rejected paths remain blocked.

When supplied, `retained` must describe the exact validated tree membership and
path identities. Selecting the default cap keeps those checks active. The
assertion does not perform removal or grant retirement or confirmation authority;
lifecycle callers retain their locks and ownership checks and use their exact
snapshot-derived cap and retained identities where available.
