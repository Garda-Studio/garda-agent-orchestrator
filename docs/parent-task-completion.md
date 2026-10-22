# Completing a parent task

The **Full parent audit and review** setting is off by default. Change it in the
dashboard's review settings, or use the confirmed, audited `workflow set
--parent-audit-enabled true|false` route described in [configuration](configuration.md).
The choice is frozen for each parent when it is decomposed. Later setting changes
apply to future parents.

| Parent origin | Setting | After all original children are accepted |
| --- | --- | --- |
| Explicit manual grouping at creation | Either | Automatically DONE |
| Decomposed during execution | Off | Automatically DONE |
| Decomposed during execution | On | One aggregate audit and independent review |

Manual grouping requires explicit creation provenance (`Decomposition source:
manual-operator` or `manual-agent`) and linked children. Editing a runtime parent's
notes later cannot turn it into a manual grouping. DONE text alone never counts
as child acceptance: native SOURCE, graph integrity and WIP custody still apply.

For an audited parent, `next-step` first requests any original validation commands
that actually ran before decomposition. A global test command merely present in
configuration is not an obligation. Genuine failed checks remain obligations;
turning off the audit does not erase a failure. Automatic parents with a failed
original test can run that exact frozen command through `parent-audit validate`.
If a suite was blocked before any command ran, automatic completion instead requires
every accepted child's current test-suite gate to pass. The original blocker stays
in history; stale or blocked child checks cannot resolve it.

The aggregate reviewer receives a generated, integrity-bound input with the
original requirements, attached plan criteria, verification expectations and
validation strategy (including its declared commands), accepted child sources, validation
outputs and complete combined diff. Launch a fresh independent subagent from the
exact input printed by `parent-audit prepare`, record its actual identity through
`parent-audit started`, and wait for its returned output before `parent-audit complete`.
Evidence references use `repository/path:line` or a bound validation-output path
and line. The reviewer reports findings; Garda validates the result and owns
completion and task creation.

Explicit plan checks remain required review obligations even if they had not run
before decomposition. The reviewer must address them with evidence or findings;
omitting one blocks acceptance. Plan prose and an unrelated configured command
cannot manufacture a passing execution result.

If there are no findings, the parent completes. Otherwise Garda creates exactly
one parent-derived F-task containing all findings and acceptance criteria. Fix it
through ordinary implementation, tests and independent reviews. Its accepted
SOURCE completes the parent automatically. The aggregate audit is not repeated,
and completed children are not reopened. New requests outside the original
requirements do not become mandatory aggregate findings.

A crashed, cancelled or invalid review attempt does not consume the audit. Record
the actual transport failure with `parent-audit failed` and its reason; `next-step`
prepares a new immutable attempt for a fresh reviewer. Accepted observations survive
an interruption while their grouped F-task is materialized. Do not reset a parent
or its children to recover these steps.

Retained runtime parents created before this policy require one explicit native
compatibility choice: `parent-audit register --audit-enabled true|false
--compatibility-reason "<original intent and selected behavior>"`. Follow the exact
command from `next-step`, including task and repository arguments. This records a
new decision without rewriting old evidence, reopening accepted leaves, or requiring
today's workflow configuration to match an old global declaration. Explicit manual
groups always retain their automatic-completion precedence.
