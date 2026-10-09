---
name: devops-k8s
description: >
  Specialist skill for production infrastructure and delivery work. Use when a
  task touches Docker images, CI/CD, Kubernetes manifests, Helm, Terraform,
  rollout strategy, secrets/config, or operational readiness. Trigger phrases:
  "deployment", "rollout", "helm", "pipeline", "kubernetes", "GitHub Actions",
  "Terraform". Do NOT use for generic application code changes with no
  deployment, infrastructure, or runtime-operations implications.
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
  domain: infrastructure
  triggers: Docker, Kubernetes, Helm, Terraform, CI/CD, GitHub Actions, deployment, rollout, observability
  role: specialist
  scope: implementation-and-review
  output-format: plans-and-review
  related-skills: infra-review, security-review, dependency-review
---

# DevOps K8s

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`. Return exactly one findings-only JSON object, complete the entire assigned scope and every coverage-ledger obligation, and do not add verdict, pass/fail, status, downstream disposition, or remediation fields.

Do not independently load task-lifecycle rules, task state, commands or token-economy configuration. As a mandatory reviewer, never run Garda, edit source, deploy/apply resources, access live infrastructure or credentials, or run Terraform plan. Execute only an exact safe check explicitly permitted by the generated handoff; the workflow and referenced checklist below never grant command authority. Read command definitions or supplied validation evidence as data within the assigned scope, without independently loading `40-commands.md` or executing its commands.

## Core Workflow

Use these as read-only review lenses within the generated scope. An explicitly authorized implementation executor may use them to plan and perform task work; a mandatory reviewer retains the boundary above throughout.

1. **Identify the delivery surface and promotion path.** Inspect supplied deployment targets, environments, GitOps vs imperative apply flow, and validation evidence. Determine whether the change affects image build, CI pipeline, manifest templating, cluster policy, or runtime operations.
2. **Lock artifact provenance and immutability.** Prefer pinned base images, digests, immutable tags, and deterministic build inputs. A deployment artifact should be reproducible from versioned inputs; if the change depends on mutable tags or floating actions, treat that as a reliability risk.
3. **Separate config from secret and environment boundaries.** Secrets should come from secret stores or sealed resources, not inline literals. Confirm environment-specific config is explicit, least-privilege access is preserved, and a change in one environment cannot silently bleed into another.
4. **Review workload safety, not just manifest syntax.** Check probes, resource requests/limits, disruption budgets, autoscaling, affinity, and storage semantics. A manifest can be syntactically valid while still producing crash loops, thundering-herd restarts, or unsafe evictions under real load.
5. **Validate rollout and rollback behavior.** Deployment strategy, image immutability, rollback commands, and migration sequencing must be coherent. If a DB migration or schema-dependent app change is involved, verify old and new versions can coexist during rollout or document the required maintenance window.
6. **Audit pipeline permissions and determinism.** Review reusable workflows, action pinning, concurrency controls, artifact handoff, and approval gates. CI/CD changes are production code; avoid steps that are non-idempotent, over-privileged, or sensitive to ordering races.
7. **Confirm observability and ownership.** Production-facing infra changes need logs, metrics, alerts, dashboards, and an operational owner. If a rollout fails, the repository should already contain the signal and the path to rollback or triage it.
8. **Evaluate validation against the intended runtime semantics.** Inspect available lint/template/validation results and identify what they actually establish; syntax alone does not prove rollout safety. Only the separately authorized implementation executor may select and run infrastructure commands from the task's command policy. Recommendations to run Helm, Kubernetes, Terraform or workflow validation are not permission for a mandatory reviewer to execute them.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Delivery checklist | `references/checklist.md` | Any infra or deployment feature/review |

## Scope Map

- **Build & supply chain** — base image pinning, artifact provenance, SBOM/signing, and deterministic CI inputs.
- **Cluster runtime** — workload manifests, probes, autoscaling, storage, networking, RBAC, and policy boundaries.
- **Promotion path** — chart values, GitOps/apply flow, approvals, rollout sequencing, rollback commands, and migration coordination.
- **Operability** — logs, metrics, alerts, dashboards, runbooks, and clear runtime ownership for production changes.

## High-Risk Areas

- Secrets rotation, ingress/network policy changes, cluster-scoped RBAC, stateful workloads, database migrations during rollout, and mutable image/action references should always be treated as high-risk changes.

## Failure Patterns

- **Syntax-valid but runtime-unsafe manifests**: probes, limits, affinity, or disruption budgets that pass templating but fail under load.
- **Mutable delivery inputs**: floating image tags, unpinned actions, or environment fallthrough that make a rollback irreproducible.
- **Pipeline-as-root**: CI jobs with broad credentials, no concurrency guard, and no environment boundary effectively bypass change management.
- **Schema-coupled rollout assumptions**: application and migration changes that only work if every pod flips at once.

## Exhaustive Review Contract
- Complete the entire assigned review scope before returning the findings-only report. A finding at any severity does not end the review.
- Continue through every in-scope file, behavior boundary, test, and applicable checklist or rule category, then report every distinct evidence-supported finding in the same result.
- Deduplicate findings that share one root cause. Include stable finding identifiers, severity, concrete file/line evidence, and impact in the fields supplied by the generated form; never invent or pad findings to reach a count.
- On remediation reviews, re-sweep the complete current assigned scope instead of checking only previously reported findings.
- Complete every coverage-ledger obligation exactly once with concrete assigned-scope evidence and the generated finding/no-finding result.
- Do not widen the assigned scope. This is a process-completeness requirement, not a guarantee that every latent defect will be discovered.

## Constraints

- Do not commit secrets or environment-specific credentials.
- Do not use mutable tags like `latest` or unpinned CI actions in production paths.
- Do not conflate readiness and liveness checks or point both at the same expensive endpoint blindly.
- Do not widen blast radius with implicit defaults, cluster-admin permissions, or environment fallthrough behavior.
- Do not ship rollout plans that assume all nodes/pods switch at once when schema compatibility is not backward-safe.
- Treat production rollout paths, migrations, and infra access changes as high-risk.

## Validation Boundary
- Missing prior focused execution evidence alone is not a finding or residual risk. Report concrete unsafe rollout, permission, provenance, or compatibility behavior with evidence; distinguish it from an unperformed validation recommendation.
- When the generated handoff permits a safe focused check, use exactly one relevant authenticated repository target. Otherwise report reserved F-000 only with the exact evidence-only marker and target required by the generated handoff, when its narrow conditions actually apply. This never authorizes Terraform plan, deployment, or access to live infrastructure.

## Standalone Advice And Implementation
Standalone advice is not a mandatory review receipt. Outside a generated mandatory review, an explicitly authorized executor may propose or implement a scoped delivery plan under the task lifecycle and command policy. State assumptions, rollout/rollback checks, and missing platform evidence truthfully. This advisory or implementation mode does not relax a generated reviewer's restrictions or grant CI, deployment, credential, or publication access.
