import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyChange } from '../../../../src/gates/preflight/classify-change';
import { defaultCapabilities, makeConfig } from './classify-change-test-support';

describe('gates/classify-change performance triggers', () => {
    it('does not trigger performance review for ordinary profile policy files', () => {
        const lowerCaseResult = classifyChange({
            normalizedFiles: ['src/policy/profile-resolver.ts'],
            taskIntent: 'Update profile review policy',
            changedLinesTotal: 20,
            additionsTotal: 12,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });
        const pascalCaseResult = classifyChange({
            normalizedFiles: ['src/policy/ProfileResolver.ts', 'src/policy/ProfileReviewPolicy.ts'],
            taskIntent: 'Update profile review policy',
            changedLinesTotal: 20,
            additionsTotal: 12,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });

        assert.equal(lowerCaseResult.triggers.performance, false);
        assert.equal(lowerCaseResult.required_reviews.performance, false);
        assert.equal(pascalCaseResult.triggers.performance, false);
        assert.equal(pascalCaseResult.required_reviews.performance, false);
    });

    it('does not trigger performance review for ordinary cache helper maintenance', () => {
        const workspaceSnapshotCacheResult = classifyChange({
            normalizedFiles: ['src/gates/workspace/workspace-snapshot-cache.ts'],
            taskIntent: 'Update workspace snapshot cache diagnostics',
            changedLinesTotal: 24,
            additionsTotal: 16,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });
        const protectedHashCacheResult = classifyChange({
            normalizedFiles: ['src/gates/protected-control-plane/protected-hash-cache.ts'],
            taskIntent: 'Update protected hash cache diagnostics',
            changedLinesTotal: 24,
            additionsTotal: 16,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });

        assert.equal(workspaceSnapshotCacheResult.triggers.performance, false);
        assert.equal(workspaceSnapshotCacheResult.required_reviews.performance, false);
        assert.deepEqual(
            workspaceSnapshotCacheResult.triggers.performance_cache_candidate_files,
            ['src/gates/workspace/workspace-snapshot-cache.ts']
        );
        assert.deepEqual(
            workspaceSnapshotCacheResult.triggers.performance_cache_suppressed_files,
            ['src/gates/workspace/workspace-snapshot-cache.ts']
        );
        assert.equal(workspaceSnapshotCacheResult.triggers.performance_cache_intent, false);
        assert.equal(protectedHashCacheResult.triggers.performance, false);
        assert.equal(protectedHashCacheResult.required_reviews.performance, false);
        assert.deepEqual(
            protectedHashCacheResult.triggers.performance_cache_candidate_files,
            ['src/gates/protected-control-plane/protected-hash-cache.ts']
        );
        assert.deepEqual(
            protectedHashCacheResult.triggers.performance_cache_suppressed_files,
            ['src/gates/protected-control-plane/protected-hash-cache.ts']
        );
        assert.equal(protectedHashCacheResult.triggers.performance_cache_intent, false);
    });

    it('keeps performance review for cache tuning intent and cache-adjacent performance paths', () => {
        const cacheTuningResult = classifyChange({
            normalizedFiles: ['src/gates/workspace/workspace-snapshot-cache.ts'],
            taskIntent: 'Tune cache eviction TTL for a hot path',
            changedLinesTotal: 24,
            additionsTotal: 16,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });
        const redisCacheResult = classifyChange({
            normalizedFiles: ['src/runtime/RedisCache.ts'],
            taskIntent: 'Update redis cache integration',
            changedLinesTotal: 24,
            additionsTotal: 16,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });
        const runtimeCacheResult = classifyChange({
            normalizedFiles: ['src/runtime/ResponseCache.ts'],
            taskIntent: 'Update response cache behavior',
            changedLinesTotal: 24,
            additionsTotal: 16,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });

        assert.equal(cacheTuningResult.triggers.performance, true);
        assert.equal(cacheTuningResult.required_reviews.performance, true);
        assert.deepEqual(
            cacheTuningResult.triggers.performance_cache_suppressed_files,
            []
        );
        assert.equal(cacheTuningResult.triggers.performance_cache_intent, true);
        assert.equal(redisCacheResult.triggers.performance, true);
        assert.equal(redisCacheResult.required_reviews.performance, true);
        assert.equal(runtimeCacheResult.triggers.performance, true);
        assert.equal(runtimeCacheResult.required_reviews.performance, true);
        assert.deepEqual(
            runtimeCacheResult.triggers.performance_cache_suppressed_files,
            []
        );
    });

    it('triggers performance review from worker queue and retry-storm runtime intent', () => {
        const workerQueueResult = classifyChange({
            normalizedFiles: ['src/integrations/telegram/update-flow.ts'],
            taskIntent: 'Add worker queue ownership for provider retry storm backoff',
            changedLinesTotal: 32,
            additionsTotal: 22,
            deletionsTotal: 10,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });
        const retryStormResult = classifyChange({
            normalizedFiles: ['src/providers/openai/responder.ts'],
            taskIntent: 'Prevent retry-storm latency spikes when provider callbacks fail',
            changedLinesTotal: 28,
            additionsTotal: 18,
            deletionsTotal: 10,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });

        assert.equal(workerQueueResult.triggers.performance, true);
        assert.equal(workerQueueResult.triggers.performance_intent, true);
        assert.equal(workerQueueResult.required_reviews.performance, true);
        assert.equal(retryStormResult.triggers.performance, true);
        assert.equal(retryStormResult.triggers.performance_intent, true);
        assert.equal(retryStormResult.required_reviews.performance, true);
    });

    it('treats explicit performance and memory findings as runtime performance intent', () => {
        for (const taskIntent of [
            'Address grouped performance review findings',
            'Address grouped perf review findings',
            'Reduce maximum timeline memory allocation',
            'Reduce heap pressure during timeline parsing',
            'Limit allocation growth in the process heap'
        ]) {
            const result = classifyChange({
                normalizedFiles: ['src/runtime/task-timeline.ts'],
                taskIntent,
                changedLinesTotal: 20,
                additionsTotal: 12,
                deletionsTotal: 8,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, performance: true }
            });

            assert.equal(result.triggers.performance_intent, true, taskIntent);
            assert.equal(result.required_reviews.performance, true, taskIntent);
        }
    });

    it('does not trigger on unrelated or distant memory terms', () => {
        for (const taskIntent of [
            'Update durable project memory handling',
            `Update memory ${'diagnostic context '.repeat(3)}allocation metadata`
        ]) {
            const result = classifyChange({
                normalizedFiles: ['src/runtime/project-memory-store.ts'],
                taskIntent,
                changedLinesTotal: 20,
                additionsTotal: 12,
                deletionsTotal: 8,
                renameCount: 0,
                detectionSource: 'git_auto',
                classificationConfig: makeConfig(),
                reviewCapabilities: { ...defaultCapabilities, performance: true }
            });

            assert.equal(result.triggers.performance_intent, false, taskIntent);
            assert.equal(result.required_reviews.performance, false, taskIntent);
        }
    });

    it('keeps performance review triggers for benchmark and profiling surfaces', () => {
        const profilingFilenameResult = classifyChange({
            normalizedFiles: ['src/runtime/RequestProfiling.ts'],
            taskIntent: 'Update request profiling instrumentation',
            changedLinesTotal: 20,
            additionsTotal: 12,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });
        const benchmarkFilenameResult = classifyChange({
            normalizedFiles: ['src/runtime/LatencyBenchmark.ts'],
            taskIntent: 'Update search benchmark',
            changedLinesTotal: 20,
            additionsTotal: 12,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });
        const performancePathResult = classifyChange({
            normalizedFiles: ['src/performance/request-latency.ts'],
            taskIntent: 'Update performance path',
            changedLinesTotal: 20,
            additionsTotal: 12,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });
        const perfPathResult = classifyChange({
            normalizedFiles: ['src/perf/latency-metric.ts'],
            taskIntent: 'Update perf path',
            changedLinesTotal: 20,
            additionsTotal: 12,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });
        const benchmarkPathResult = classifyChange({
            normalizedFiles: ['src/benchmark/latency-metric.ts'],
            taskIntent: 'Update performance benchmark paths',
            changedLinesTotal: 20,
            additionsTotal: 12,
            deletionsTotal: 8,
            renameCount: 0,
            detectionSource: 'git_auto',
            classificationConfig: makeConfig(),
            reviewCapabilities: { ...defaultCapabilities, performance: true }
        });

        assert.equal(profilingFilenameResult.triggers.performance, true);
        assert.equal(profilingFilenameResult.required_reviews.performance, true);
        assert.equal(benchmarkFilenameResult.triggers.performance, true);
        assert.equal(benchmarkFilenameResult.required_reviews.performance, true);
        assert.equal(performancePathResult.triggers.performance, true);
        assert.equal(performancePathResult.required_reviews.performance, true);
        assert.equal(perfPathResult.triggers.performance, true);
        assert.equal(perfPathResult.required_reviews.performance, true);
        assert.equal(benchmarkPathResult.triggers.performance, true);
        assert.equal(benchmarkPathResult.required_reviews.performance, true);
    });
});
