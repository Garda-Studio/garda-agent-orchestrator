import { inspectTaskEventFile, withTaskTimelineReadSnapshot } from '../../../../src/gate-runtime/task-events';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { createNextStepLongHistoryFixture } from './next-step-long-history-fixture';
import { resolveNextStep } from './next-step-test-support';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { getRepoRoot } from '../../../../scripts/node-foundation/build';

test('long-history navigator instrumentation preserves its route and output and counts actual work', { timeout: 120_000 }, () => {
    const fixture = createNextStepLongHistoryFixture();
    assert.ok(fixture.timelineBytes > 1_500_000);
    const plain = resolveNextStep(fixture);
    let measurement: NextStepMeasurement | undefined;
    const timelineRoot = path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
    const observed: number[] = [];
    const measured = withNextStepMeasurement(() => withTaskTimelineReadSnapshot(timelineRoot, fixture.taskId, () => {
        const result = resolveNextStep(fixture);
        for (let observer = 0; observer < 2; observer += 1) {
            let count = 0;
            const inspection = inspectTaskEventFile(path.join(timelineRoot, fixture.taskId + '.jsonl'), fixture.taskId,
                { onIntegrityEvent: () => { count += 1; } });
            assert.equal(inspection.status, 'PASS');
            observed.push(count);
        }
        return result;
    }), value => { measurement = value; });
    assert.ok(observed[0] > 640);
    assert.equal(observed[0], observed[1]);
    const stable = (result: typeof plain) => { const { generated_utc: _time, ...rest } = result; return rest; };
    assert.deepEqual(stable(measured), stable(plain));
    assert.equal(measurement?.work.audit, 1);
    assert.equal(measurement?.work.timeline_verify, 1);
    assert.equal(measurement?.work.timeline_parse, 1);
    for (const [key, count] of Object.entries(measurement?.work || {})) {
        if (key.startsWith('artifact_bytes:') || key.startsWith('artifact_json_parse:') || key.startsWith('git:') || key.startsWith('git_binary:') || key.startsWith('icacls:')) {
            assert.equal(count, 1, key);
        }
    }
    assert.ok(Object.keys(measurement?.work || {}).some(key => key.startsWith('artifact_bytes:')));
    if (process.env.GARDA_BENCHMARK_REPORT) {
        const run = spawnSync(process.execPath, [path.join(getRepoRoot(), 'scripts/benchmark-next-step.cjs'), fixture.taskId, fixture.repoRoot, '6'], {
            cwd: getRepoRoot(), encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024
        });
        assert.equal(run.status, 0, run.stderr);
        fs.writeFileSync(process.env.GARDA_BENCHMARK_REPORT, run.stdout);
    }
});
