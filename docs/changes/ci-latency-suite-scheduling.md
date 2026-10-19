# Run latency acceptance after parallel shards

The timeline performance acceptance suite previously ran in its own shard while
other shards still executed. A hosted Ubuntu Node 22 Release check reported a
1028 ms p95-to-median spread against the existing 1000 ms limit. Separating test
files into processes does not isolate their CPU or filesystem contention.

The suite now uses the existing serial lane, which waits for parallel shards to
finish before starting each contention-sensitive file. The scheduler regression
includes the actual performance suite and asserts that no other child is active
when a serial child starts, as well as exact execution order and concurrency.

Production code, sample count, latency thresholds, heap limits, allocation and
I/O assertions remain unchanged. A focused native Linux Node 22 performance run
qualifies the original failed scenario; hosted acceptance remains tied to the
actual selected Release job on its dispatched commit.
