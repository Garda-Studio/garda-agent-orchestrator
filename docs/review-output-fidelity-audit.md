# Path-based review output fidelity audit

Audit scope: T-073, inspected on 2026-09-22. The implementation already preserves
path-based PASS output; no materialization change is needed. This audit adds
exact-byte/hash and preserved-residual-text assertions to existing regressions.

## Current contract

- Path input must resolve inside the repository and respect task ownership of
  review scratch output. External symlink/junction escapes and aliases into
  another task's scratch directory are rejected.
- Canonical raw reviewer output is stored separately from the normalized review
  artifact. Successful materialization records the canonical output path,
  source mtime, raw-output digest, artifact digest and fidelity classification.
- Path-mode output older than delegation-start evidence, or with ambiguous
  delegation timing, is rejected with stdin recovery guidance. This is a
  metadata consistency check, not cryptographic proof of file authorship.
- Lossless PASS normalization may classify narrative residual-risk notes as
  non-actionable, while retaining the original text in the raw artifact and the
  normalized artifact's preserved-output section. Actionable findings still
  follow the existing findings/disposition contract.
- Rejected or empty replacement input does not overwrite existing canonical
  raw output. Stdin uses the same validation and receipt path.

## Regression evidence

`tests/node/cli/commands/gates/review-result/gates-command-review-result-output.test.ts`
covers path escapes, foreign-task aliases, exact PASS materialization, original
mtime, stale/ambiguous timing, canonical-path recovery, stdin parity and rejected
replacement preservation. Its exact-materialization test now compares original
bytes and recomputes both receipt digests independently with SHA-256.

`tests/node/cli/commands/gates/review-result/gates-command-review-result-normalization-suite.ts`
covers lossless normalization and residual-risk disposition. The test
`record-review-result does not convert T-547-2 PASS residual-risk noise into deferred findings`
now also asserts that the complete original reviewer text survives inside the
normalized artifact and that both receipt digests match their actual content.
The suite runs through its six `gates-command-review-result-normalization-*.test.ts`
partitions.

The production owners are
`src/cli/commands/gate-review-handlers/result/review-result-handlers.ts`,
`review-result-output-safety.ts` and `review-artifact-materialization.ts` in the
same directory. The raw-output contract still applies secret redaction; fidelity
does not authorize persisting credentials. This audit does not change the
separate test-only remediation routing behavior owned by T-892.
