---
name: performance-review
description: >
  Reviews code changes for latency regressions, concurrency bottlenecks, caching misuse,
  payload bloat, fan-out risks, and queue/backpressure gaps. Uses evidence proportional to
  the changed behavior and requires reproducible measurements for quantitative claims.
  Use when a task touches hot paths, caching layers, connection/thread pools, batch/stream
  processing, queue consumers, serialization formats, or when the task description mentions
  latency, throughput, p99, response time, or load testing.
  Trigger phrases: perf review, latency review, performance audit, hot-path review.
  Follow preflight lane selection; a selected lane does not make every performance
  checklist item applicable to cosmetic, descriptive, or unrelated changes.
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
  triggers: latency budget, hot path, cache, concurrency, fan-out, payload size, queue, backpressure, benchmark, load test, profiling
  role: specialist
  scope: review
  output-format: review-findings
  related-skills: code-review, architecture-review, node-backend
---

# Performance Review

## Generated Findings-Only Handoff
When orchestration supplies generated role-prompt, prompt-template, reviewer-prompt, output-template, and evidence-manifest artifacts, those artifacts are the sole instruction and output-format authority. Use this skill only as the assigned review lens/checklist. Never modify source files, control artifacts, or task state, and never launch another agent; the only permitted write is the exact `ReviewOutputPath`.

Return exactly one findings-only JSON object using the generated output template. Complete the entire assigned scope and every coverage-ledger obligation. Do not add verdict, pass/fail, status, downstream disposition, or remediation fields. The controller owns policy and acceptance; the reviewer reports evidence-supported findings and risks.

## Core Workflow

1. **Determine applicable risk and claims.** Identify changed hot paths, resource lifetimes, workload assumptions and quantitative claims. Apply the checklist to those boundaries, explain inapplicable categories, and still inspect every assigned file and coverage obligation. Use existing SLOs or deadlines when relevant; a selected lane alone does not require new SLOs, percentile telemetry or benchmarks.
2. **Map the hot path.** Trace the request or event from entry to response/ack. Identify every I/O call, serialization step, lock acquisition, and allocation on the critical path. Mark segments that run under concurrency (shared pool, event loop, goroutine fan-out).
3. **Evaluate caching changes.** Establish capacity, eviction or lifetime bounds and freshness/invalidation requirements. TTL is one valid mechanism, not a universal requirement: bounded capacity with correct invalidation or a bounded owner lifetime can satisfy the contract. Assess stampedes and cold starts where concurrent population is possible. Missing hit-rate telemetry alone is not a finding; require observability when it supports a stated claim or identifies a concrete operational risk. Retain findings for demonstrated unbounded growth, stale data or authorization bypass.
4. **Assess concurrency and pool sizing.** Check connection pools, thread/worker pools, and semaphore limits. Verify that pool exhaustion produces a clear backpressure signal (reject, queue with bounded depth, circuit-break) rather than silent queueing or OOM. Flag shared mutable state accessed without synchronization.
5. **Check payload and serialization.** Verify response payloads are bounded (pagination, field selection, compression). Flag N+1 data fetches, unbounded list expansions, and unnecessary deep cloning or re-serialization on the hot path.
6. **Review fan-out and downstream calls.** Inspect ordering, shared resources, cancellation and failure semantics before recommending parallelism. Preserve intentionally serial mutations, transaction order and lock ownership. Recommend bounded parallelism only for independent work with compatible shared-resource capacity and a demonstrated benefit. Check downstream timeouts, partial failures and deadline accounting when those boundaries exist.
7. **Verify queue and backpressure design.** For producer/consumer flows, confirm: bounded queue depth, dead-letter routing, consumer concurrency limit, and visibility timeout or ack deadline. Flag fire-and-forget patterns without delivery guarantees where correctness matters.
8. **Match evidence to the conclusion.** Quantitative improvement claims require reproducible before/after measurements under comparable workloads and environments, with the relevant metric, sample size and distribution. Account for warm-up and GC where applicable. A concrete regression may instead be demonstrated by source/data flow, a focused regression test, a profile or a reproducible workload; universal benchmark or hit-rate requirements do not follow from lane selection. State uncertainty honestly and report the supported defect or claim-validation limitation without inventing measurements.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Performance review checklist | `references/checklist.md` | Any performance-sensitive change or review |

## Scope Examples

### Bounded Cache
A 64-entry cache with eviction and generation-based invalidation has bounded memory and explicit freshness. Missing TTL or hit-rate telemetry alone is not a finding. Inspect whether the stated bounds and invalidation actually cover the changed lifetime and inputs.

### Unbounded Growth
A map retains one entry for each unique untrusted input without eviction or a bounded owner lifetime. Report the demonstrated retained growth and impact; do not suppress it because no latency SLO or before/after benchmark exists.

### Measured Optimization Claim
A claimed 20% latency reduction requires comparable before/after measurements: workload, environment, relevant metric, sample size and distribution. Missing measurements prevent substantiating that quantitative claim; unrelated descriptive changes do not inherit this requirement.

### Intentionally Serial Mutations
Two writes in one transaction require order, or operations mutate the same lock-protected resource. Preserve serialization unless independence, correctness and bounded shared-resource capacity are established. Serial execution alone is not a performance defect.

## Anti-Patterns

- **Microbenchmark theater**: claiming improvement from isolated benchmarks while ignoring p95 or p99 latency, queue depth, or system-level saturation behavior.
- **Cache without an invalidation story**: adding a cache that improves the happy path while quietly introducing stale reads, stampedes, or unbounded memory growth.
- **Unlimited parallelism**: fan-out that reduces single-request latency in staging but collapses shared pools or downstream dependencies under production concurrency.
- **Pool tuning without overload semantics**: changing worker, connection, or thread counts without stating what happens when the pool saturates.

## Exhaustive Review Contract
- Complete the entire assigned review scope before returning findings. A finding at any severity does not end the review.
- Continue through every in-scope file, behavior boundary, test, and applicable checklist or rule category, then report every distinct evidence-supported finding in the same result.
- Deduplicate findings that share one root cause. For every distinct finding include severity, file and line evidence and observed impact; never invent or pad findings to reach a count.
- On remediation reviews, re-sweep the complete current assigned scope instead of checking only previously reported findings.
- Validation Notes must name the files, behavior boundaries, tests, and checklist or rule categories actually reviewed.
- Do not widen the assigned scope. This is a process-completeness requirement, not a guarantee that every latent defect will be discovered.

## Evidence Boundaries

- Preserve findings for actual unbounded work, retained growth, resource exhaustion, overload and correctness regressions. Explain workload relevance and evidence instead of turning an inapplicable checklist item into a defect.
- Do not trade correctness, authorization, transaction order, lock ownership or required validation for speed. Assess the concrete effect of removing timeouts, rate limits or circuit-breakers using the relevant failure model.
- Preserve current gate-owned execution evidence. Missing prior focused execution alone is not a finding or residual risk. Follow the generated handoff's narrow focused self-validation exception when that absence is the prospective concern; record the exact permitted command, outcome and diagnostics. Reserved F-000 applies only under that generated contract; do not duplicate its marker or substitute a custom runner.
- Use the generated output form and evidence budget. Do not independently load task lifecycle, command policy or token-economy settings, create a benchmark framework, change source, launch an agent or redefine mandatory review selection.

## Standalone Advice

Without a generated handoff, provide advisory findings with concrete scope, severity, evidence and honest limitations. Standalone advice is not a mandatory review receipt or task acceptance.
