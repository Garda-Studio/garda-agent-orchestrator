# Core Rules

Primary entry point: selected source-of-truth entrypoint for this workspace.

## Language
Respond in {{ASSISTANT_RESPONSE_LANGUAGE}} for explanations and assistance.

## Response Style
Default response brevity: {{ASSISTANT_RESPONSE_BREVITY}}.

## Communication
1. Respond in {{ASSISTANT_RESPONSE_LANGUAGE}}.
2. Keep responses {{ASSISTANT_RESPONSE_BREVITY}} unless the user explicitly asks for more or less detail.
3. Keep code in English (variables, functions, classes, comments in code).
4. Keep documentation in English (README, docs, file content).
5. Task completion ends with a short agent-authored summary and the verbatim Garda final user report, followed by the native commit guidance in the current final-report contract. An authenticated workspace-local ON grant supplies durable operator permission; do not ask the same commit question again. OFF or missing authority blocks native commits. Follow `80-task-workflow.md` for scope checks and post-commit audit.

## Project Memory — Storage Directive
1. Durable project knowledge (architecture, conventions, stack details, domain constraints, design decisions) must be written to `garda-agent-orchestrator/live/docs/project-memory/` as a compact project map, not as a task log.
2. Do not embed durable project knowledge in orchestrator-managed rule files (`agent-rules/*.md`), config JSON, root entrypoints, or `TASK.md`.
3. The `project-memory/` directory is user-owned; lifecycle materialization may add missing seed files, but must not overwrite, merge, or delete existing files.
4. When reading project memory, start with `README.md`, then `compact.md`, then only the focused memory files relevant to the task.
5. Canonical focused files: `context.md`, `stack.md`, `architecture.md`, `module-map.md`, `commands.md`, `conventions.md`, `decisions.md`, `risks.md`. Add new files in lowercase kebab-case `.md` format when an existing category does not fit.
6. Agents may read `project-memory/` at any time for context. Write access requires explicit user approval or a task instruction that authorises the update.
7. Project-memory writes must record durable current-state contracts only: module ownership, workflow invariants, commands, decisions, risks, and active unknowns. Do not store repeated task narratives, transient failures, large command outputs, or duplicated known orchestrator issues. Task ids are optional provenance only and should not be the default heading structure.

## Mandatory Infrastructure Integrity
1. Mandatory gate/tooling failures (e.g., `Unknown gate`, missing CLI capability, missing local build dependencies, stale bundle mismatch, unreadable gate artifact paths) are critical infrastructure defects.
2. Any such failure forces an immediate `BLOCKED` condition. You must not continue task execution or implementation when gate infrastructure is broken.
3. User preferences or environment-specific instructions (e.g., "do not run rebuild", "skip tests") never waive mandatory gate validation. If a gate requires a build, test, type-check, or full-suite command to satisfy its contract, run the gate and let the gate manage that command. The `40-commands.md` restraint applies only to standalone ad-hoc commands outside the lifecycle; it does not apply to `compile-gate`, `full-suite-validation`, or any other required lifecycle gate.
4. Manual verification outside the lifecycle must start compact and targeted: prefer `gate run-intermediate-command` for eligible focused test, typecheck, or validation probes; otherwise use the bounded Manual Validation Logs pattern from `40-commands.md`. Raw `npm test` or `node --test` reruns are escalation steps, not the default path, and they never replace mandatory `full-suite-validation`.
5. Broken gate infrastructure is not permission to bypass the orchestrator or edit code directly without following the lifecycle.
6. When blocked by infrastructure failure, report the exact command, `cwd`, chosen CLI path, and the complete `stderr` output to the user.
7. Mandatory reviewer launch evidence is one-shot: no agent may create, reserve, hold, or complete a reviewer before `prepare-reviewer-launch` prints the exact `CopyPasteReviewerLaunchPrompt` or `ReviewerLaunchInputArtifactPath`; planned `agent:pending:<task-id>-<review-type>` identities are placeholders until `record-reviewer-delegation-started` records the resolved provider `agent:*` identity.

## Security-Sensitive Trust Boundaries
1. Before the first reviewer launch for security, authorization, protected-control-plane, recovery, evidence, or artifact-trust changes, complete the active `trust_boundary_adversarial_analysis` quality-check rule.
2. The answer must contain a compact `trust_boundary_matrix` that names every trust boundary and records its authority source, mutable inputs, immutable or integrity-bound evidence, canonical reconstruction, TOCTOU or replay behavior, and targeted negative paths with test evidence.
3. Happy-path evidence alone is not sufficient. Missing or incomplete matrix fields block the quality checklist, and the authenticated matrix must be included in the reviewer handoff.
4. Non-security changes skip this rule by preflight scope; do not add generic threat-model boilerplate to unrelated work or treat the matrix as a replacement for independent security review.

## Code Quality

For supported inspections, prefer the enabled `garda compact` CLI described in `40-commands.md`; next-step and reviewer handoffs provide the local invocation. This does not replace mandatory evidence reads or gates.

### Cleanliness and Readability
- Code must be self-documenting.
- Use meaningful names (`productRepository` instead of `repo`).
- Keep functions small and focused.
- Avoid magic numbers and use constants.

### Single Responsibility Principle (SRP)
- Each class or function should have one responsibility.
- Split functions that perform multiple responsibilities.
- Split classes that have multiple reasons to change.

### DRY (Don't Repeat Yourself)
- Do not duplicate code; extract shared logic.
- Avoid copy-paste solutions.
- Reuse services, utilities, and base abstractions.

### Comments
- Minimize comments.
- Do not comment obvious behavior.
- Write comments only in English.
- Use comments only for rationale or non-obvious business constraints.

Bad example:
```java
// Increment counter
counter++;
```

Good example:
```java
// Skip first element due to API limitation that always returns a duplicate
items.stream().skip(1)...
```
