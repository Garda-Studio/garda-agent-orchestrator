# Declared file roles

Declare exact project file roles in `garda-agent-orchestrator/live/config/paths.json`
before starting a task. The ordinary workflow uses these declarations for every
stack; no validation recipe or language adapter is required.

```json
{
  "file_roles": {
    "src/view.mdx": "source",
    "config/executable-rules.yaml": "source",
    "specifications/purchase.case": "test",
    "quality/购买": "test"
  }
}
```

Paths are canonical repository-relative file names, not globs. Roles are `source`
or `test`; omitted paths retain the existing conservative classification rules.
Unknown file forms still default to source. Explicit source roles override
documentation/configuration names and conventional test paths. Explicit test
roles allow an unfamiliar test form to participate in test-only scope.
Protected Garda control-plane boundaries retain their existing safeguards.

The task profile snapshot freezes ordinary project declarations. Classification,
review scope fingerprints, reuse and remediation use the same role projection.
Audited validation recipes contribute their declared source/test inputs through
the existing admission authority; helper/config inputs do not declare tests.
Conflicting source/test declarations fail closed. These declarations describe
file roles and do not authorize commands, weaken execution evidence or certify a
test outcome.

Closeout excludes declared source/test files from user documentation fields.
Actual source/configuration changes retain their behavior impact even when the
public changelog is unchanged; the generated command then requests the required
internal evidence. Documentation-only edits keep the ordinary documentation
closeout path.

The preflight keeps planned authorization separately from actual Git changes.
An unchanged authorized source file does not turn an actual documentation or
test edit into a source change. Rename, deletion and staged-content fingerprints
continue to use the actual selected Git scope. Changing a declaration requires a
fresh task snapshot through the ordinary audited workflow; editing live paths
does not rewrite the frozen roles of an active task.
