---
name: api-contract-review
description: >
  Reviews API and interface contracts for directional compatibility, schema correctness, and breaking-change risk.
  Use for OpenAPI/Swagger, protobuf/IDL, GraphQL, typed clients, request/response shapes, errors,
  persisted JSON/config schemas, CLI arguments, and machine-readable CLI output consumed across versions.
  Trigger phrases: api review, contract review, schema review, breaking change review.
  Do NOT use for internal refactors with no independently consumed interface or stored-data boundary.
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  domain: quality
  triggers: OpenAPI, Swagger, protobuf, GraphQL, typed API client, REST contract, gRPC, JSON Schema, persisted config, CLI readers
  role: specialist
  scope: review
  output-format: review-findings
  related-skills: code-review, node-backend, dependency-review
---

# API Contract Review

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`.

Return exactly one findings-only JSON object using the generated output template. Complete the entire assigned scope and every coverage-ledger obligation. Do not add verdict, pass/fail, status, downstream disposition, or remediation fields. The controller owns acceptance and follow-up decisions.

## Core Workflow

1. **Locate the consumed surfaces.** Inspect changed specifications and their actual producers and consumers: HTTP/RPC schemas, typed clients, persisted JSON/config, CLI arguments and machine-readable CLI output. A file format or internal client can be a compatibility boundary when readers and writers evolve independently.
2. **Map direction and rollout.** Identify old/new request callers and accepting servers, response producers and decoding clients, or stored-data writers and readers. Review new producer with old consumer and, where supported during rollout or rollback, old producer with new consumer. Do not classify compatibility from the word "additive" alone.
3. **Compare the actual contract.** Use the prior committed shape, changed implementation and supplied usage evidence. Check accepted input sets, emitted output sets, field presence, types, nullability, defaults, unknown-field behavior, errors and semantic meaning using the directional matrix below.
4. **Apply project evolution conventions.** Use the project's existing versioning, deprecation, migration and error conventions. A demonstrated break may need a compatible rollout, migration or versioned surface under those conventions. Uncertainty alone does not justify an automatic version bump; state the missing evidence and inspect it within the assigned scope.
5. **Inspect relevant protocol behavior.** Where changed, check status/error mapping, pagination and cursor stability, filter semantics, idempotency and retry behavior. Use existing envelopes and transport semantics; do not prescribe one universal error shape or HTTP policy for every interface.
6. **Check proportionate contract coverage.** Look for assertions using relevant old/new consumers and producers, stored fixtures or CLI readers, including negative paths and observable semantics. An annotation or generated schema alone does not prove runtime validation, default application or decoder tolerance.
7. **Report demonstrated impact.** Continue through every assigned file, boundary and checklist category. Deduplicate shared root causes and give each supported finding concrete file:line evidence and consumer impact. Severity follows demonstrated failure, exposure and project impact; a schema edit or error-envelope difference is not automatically high severity.

## Directional Compatibility Matrix

Assume the prior contract and observable semantics are preserved unless the change says otherwise; verify that assumption against the assigned evidence.

| Change | Request-consumer: new server accepting old callers | Response-producer: new producer serving old readers |
|---|---|---|
| Enum or accepted type expansion | Old callers remain valid when the new accepted set contains the old set. New callers using new values may still fail against old servers. | Newly emitted values or types may fail an old strict decoder. Check tolerant fallbacks rather than assuming expansion is safe. |
| Enum or accepted type narrowing | Removing an input formerly accepted can reject a correct old caller. | A smaller emitted set can remain decodable by old readers, but verify promised meanings and behavior. A new narrower reader may reject values from an old producer during rollback. |
| Nullability | Accepting null adds input capability; rejecting previously accepted null can break old callers. | Newly emitting null can break an old non-null reader. Removing emitted null can preserve decoding but may change promised meaning. |
| Required/optional fields | Requiring a formerly omitted input can break old callers unless omission still has an actual compatible runtime path. | Omitting a formerly guaranteed output can break old readers. Adding even an optional field can break readers that reject unknown fields. |
| Defaults | Changing the effective default can change an old caller's omitted-input behavior. A schema default annotation need not insert a value. | Changing produced defaults or interpretation of old stored data can change behavior even when the shape still validates. |
| Unknown fields | Tightening rejection of formerly tolerated input fields can break callers. Widening acceptance still needs defined semantics and validation. | New fields can break strict old readers; tolerant readers may ignore them. Verify the actual decoder and meaningful field use. |
| Errors and status values | New validation may reject previously accepted requests; inspect which old calls are affected. | New error codes, shapes or status meanings can break old error decoders or control flow. Use the project's existing error conventions and impact-based severity. |

For persisted JSON/config, apply the same distinction to data written by a producer and accepted by a reader. For CLI arguments, review accepted input; for CLI JSON or other machine output, review emitted output. Also check old stored data with a new reader and new data with a reader retained for rollback.

## Concrete Examples

### Response enum expansion

An old strict decoder accepts only `queued` and `done`. A new producer adds `running` and emits:

```json
{"state":"running"}
```

That old decoder rejects this response despite the enum expansion being described as additive. A producer emitting only `done` remains within its old accepted set, subject to unchanged semantics. Check actual decoder tolerance and supported rollout directions before recommending a project-specific remedy.

### Request enum expansion

An old server accepts `read` and `write`; a new server also accepts `append`. Both old caller payloads remain accepted:

```json
{"mode":"read"}
```

```json
{"mode":"write"}
```

A new caller can use:

```json
{"mode":"append"}
```

The expansion preserves old callers on the new server. It does not guarantee that the old server accepts the new caller's `append`, or that unrelated response/error behavior is compatible.

### Persisted config and CLI readers

An existing stored config contains:

```json
{"mode":"safe"}
```

A new reader requiring `retryLimit` cannot read that old file merely because its schema annotates `default: 3`. Verify a real applied default or a migration, for example:

```json
{"mode":"safe","retryLimit":3}
```

A CLI producer can also break an old strict `phase` reader accepting only `queued` and `done` by emitting:

```json
{"phase":"running"}
```

These are schema/API compatibility surfaces even without HTTP. Preserve supported stored-data versions, CLI readers and rollback paths using the project's actual conventions.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Directional contract review checklist | `references/checklist.md` | Any assigned contract/schema review |

## Exhaustive Scope And Validation Boundary

- Re-sweep the complete current assigned scope on remediation reviews, and complete every generated coverage-ledger obligation with concrete evidence. A finding at any severity does not end the review.
- Record the files, old/new directions, behavior boundaries, tests and checklist categories actually inspected. Describe concrete missing counterpart or usage evidence without inventing a compatibility guarantee or widening the assigned scope.
- Missing prior focused execution evidence alone is not a finding. Follow the generated handoff's narrow focused self-validation contract for one authenticated repository target; do not invoke task lifecycle tools, create runners, mutate source/control artifacts, launch agents, use network services or duplicate current gate-owned checks.
- Record exact attempted command, outcome and concrete diagnostics in the generated form. Report an exposed defect with its ordinary finding ID. An unavailable/prohibited attempt may use reserved F-000 only with the generated handoff's exact evidence-only marker and target; this skill does not redefine that marker or the schema.
- Without a generated handoff, give clearly advisory, evidence-supported findings and limitations. Standalone advice is not a mandatory review receipt or proof of task completion.
