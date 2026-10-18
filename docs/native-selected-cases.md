# Native selected-case evidence

An ordinary `gate run-intermediate-command` with the current native preflight
records contained file operands before execution and checks their identities
afterwards. This association uses literal arguments, without a runner-name,
option-name or source-extension list. The authenticated task timeline records
the selection before starting the process; the completed record retains the
process status, actual invocation arguments, output and source identities.

A symbolic selector can name a case without naming its source in the command.
Supply repeated `--selected-case` JSON values with `source`, `case_id` and
`selector` fields. For example, a PowerShell invocation can include:

```powershell
--command 'widget-check --scenario=refund-empty' `
--selected-case '{"source":"checks/refund.case","case_id":"refund-empty","selector":"refund-empty"}'
```

Literal file operands are candidate observations: they can include generated
reports. Native case projection requires unchanged before/after/current identity
for its selected source, so replacing or deleting a generated report does not
invalidate an unchanged case source. Unobservable automatic operands are retained
as diagnostics and cannot stand in for a captured source. Explicit source claims
must pass the source identity checks before execution.

The selector must occur literally in the actual command, either as an argument
or as the value following `=`. Sources must be contained regular files. Claims
are bounded and cannot authorize a command, change its arguments or establish
that an assertion ran. A direct file operand uses the same relation without
requiring explicit case metadata.

Each case uses its latest matching execution by attempt start order. An older
process finishing later cannot override a newer attempt. An unsuccessful or unfinished
matching attempt supersedes an older success, including a repeated identical
invocation that omits earlier case metadata. Invocation identity uses the
literal executable and argument vector, so equivalent whitespace and quoting
do not create a new identity. An unrelated case keeps its own
execution. Changed, replaced, foreign or unavailable source/output evidence
cannot close a case. Historical records retain their existing conservative
currentness rules.

Exit zero establishes a successful process only. Case outcomes remain
`UNRESOLVED` until independent review inspects the selected assertion and the
retained output. Missing or skipped assertions cannot become a semantic PASS
through selection metadata.
