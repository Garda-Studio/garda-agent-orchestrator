# Performance Review Checklist

Apply each item only to a relevant changed behavior, resource boundary or quantitative claim. Explain inapplicable categories in the generated validation notes while completing every assigned file and coverage obligation. Lane selection alone does not require benchmarks, new SLOs, TTL or hit-rate telemetry. Concrete unbounded work, overload and correctness risks remain review findings.

## Latency Budget

- [ ] Existing SLO, percentile or deadline requirements relevant to the change are identified; do not require a new SLO for an unrelated or descriptive change.
- [ ] Where a real end-to-end deadline exists, changed stages respect it and preserve timeout/cancellation propagation.
- [ ] Claimed latency improvements identify the metric and appropriate comparison; a missing unrelated percentile metric alone is not a finding.

## Hot Path & I/O

- [ ] Critical path is identified; no unnecessary I/O, allocation, or serialization on it.
- [ ] N+1 query/call patterns are absent or mitigated (batching, DataLoader, join).
- [ ] Blocking calls do not run on an async/event-loop thread.
- [ ] Heavy computation is offloaded from the request-serving thread/loop where applicable.

## Caching

- [ ] Capacity, eviction or owner lifetime bounds retained data; inspect actual unbounded growth.
- [ ] Freshness and invalidation fit the data contract (event-driven invalidation, TTL, versioned keys or bounded lifetime); TTL is not universal.
- [ ] Stampede protection and cold-start behavior are assessed where concurrent population is possible.
- [ ] Hit-rate telemetry supports a stated claim or concrete operational need where applicable; its absence alone is not a defect.
- [ ] Cached data does not bypass authorization checks on read.

## Concurrency & Pools

- [ ] Connection/thread/worker pool sizes are configured, not left at unbounded defaults.
- [ ] Pool exhaustion produces a clear signal (reject, backpressure, metric) not silent hang.
- [ ] Shared mutable state is accessed under proper synchronization (lock, atomic, channel).
- [ ] Lock duration fits required ownership and ordering; report avoidable contention without recommending unsafe unlocks.

## Payload & Serialization

- [ ] Response payloads are bounded (pagination, field selection, max-items).
- [ ] Large payloads use streaming or chunked transfer where appropriate.
- [ ] Streaming, chunking or compression is considered where payload size, consumers and measured cost justify it.
- [ ] No unnecessary deep clone or re-serialization on the hot path.

## Fan-Out & Downstream Calls

- [ ] Parallel work is independent and has bounded concurrency consistent with shared-resource capacity.
- [ ] Downstream timeouts/cancellation respect the actual request or operation deadline where one exists.
- [ ] Relevant partial failures have defined handling (degrade, retry subset, abort).
- [ ] Intentionally serial mutations, transaction order and lock-protected shared resources retain their ordering. Parallelism requires proven independence, correctness and benefit.

## Queue & Backpressure

- [ ] Queue depth is bounded; producers receive backpressure when the queue is full.
- [ ] Dead-letter or poison-message routing is configured for unprocessable items.
- [ ] Consumer concurrency is capped; visibility timeout or ack deadline matches processing time.
- [ ] Fire-and-forget patterns are documented and acceptable for the correctness requirement.

## Measurement & Evidence

- [ ] Quantitative improvement claims have reproducible comparable before/after measurements.
- [ ] Those measurements identify workload, environment, relevant metric, sample size and distribution; account for warm-up, GC and JIT where applicable.
- [ ] Concrete regressions use appropriate source/data-flow evidence, a focused test, a profile or a reproducible workload; not every selected lane requires a benchmark.
- [ ] Existing current validation is used without duplicating gate-owned execution. Missing prior focused execution follows only the generated handoff's narrow safe-check exception.
- [ ] Relevant regression checks protect actual changed risks; do not introduce an unrelated benchmark or telemetry framework.
