import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withInvocationReadObservation, registerInvocationDependency } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { resolveNextStep } from '../../../../src/gates/next-step';
import { createNextStepLongHistoryFixture } from './next-step-long-history-fixture';
import { eventsRoot, reviewsRoot } from './next-step-review-cycle-fixtures';
import { measureHistoryRoute } from './next-step-authenticated-budget-fixture';

test('Q2 real next-step shares scope bytes and rejects input replacements after its last consumer', t => {
    const fixture = createNextStepLongHistoryFixture(1);
    const { repoRoot, taskId } = fixture;
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const options = { repoRoot, taskId };
    let measurement: NextStepMeasurement | undefined;
    const stable = (result: ReturnType<typeof resolveNextStep>) => ({ ...result, generated_utc: '<time>' });
    const before = stable(withNextStepMeasurement(() => resolveNextStep(options), value => { measurement = value; }));
    const hashes = Object.entries(measurement!.work).filter(([key]) => key.startsWith('file_hash:') && /[\\/]src[\\/]file-\d+\.ts$/u.test(key));
    assert.equal(measurement!.work['timeline_revalidate:' + path.join(eventsRoot(repoRoot), taskId + '.jsonl')], 1,
        'Q6 validates this task timeline once at invocation exit; other task inputs retain separate checks.');
    assert.equal(hashes.length, 64);
    assert.ok(hashes.every(([, value]) => value === 1), JSON.stringify(hashes));
    const normalized = measureHistoryRoute({ ...options,
        files: Array.from({ length: 64 }, (_, index) => 'src/file-' + String(index).padStart(2, '0') + '.ts'),
        historicalArtifacts: [], artifactCycles: {}
    }, 'observation-counter-regression');
    const aclKeys = Object.keys(normalized.counters).filter(key => key.startsWith('acl_'));
    if (process.platform === 'win32') {
        assert.ok(aclKeys.length > 0);
        assert.ok(aclKeys.some(key => key.includes('acl_probe:initial:current:') && key.endsWith('/task-events')));
        assert.ok(aclKeys.some(key => key.includes('acl_probe:final:current:') && key.endsWith('/<task>.jsonl')));
    }
    assert.ok(aclKeys.every(key => !key.toLowerCase().includes(repoRoot.toLowerCase())),
        'History comparison must retain ACL object and phase counts without the random fixture root.');
    const nativePathKeys = Object.keys(normalized.counters).filter(key => key.startsWith('native_realpath_'));
    assert.ok(nativePathKeys.length > 0);
    assert.ok(nativePathKeys.every(key => !key.replaceAll('\\', '/').toLowerCase().includes(repoRoot.replaceAll('\\', '/').toLowerCase())),
        'History comparison retains native path-check counts independently of temporary workspace names.');
    for (const file of [
        path.join(eventsRoot(repoRoot), taskId + '.jsonl'),
        path.join(reviewsRoot(repoRoot), taskId + '-preflight.json'),
        path.join(repoRoot, 'src', 'file-00.ts')
    ]) {
        assert.throws(() => withInvocationReadObservation(() => {
            registerInvocationDependency({}, () => {
                const replacement = file + '.q2-replacement';
                fs.writeFileSync(replacement, fs.readFileSync(file), { mode: fs.statSync(file).mode });
                fs.renameSync(replacement, file);
            });
            assert.deepEqual(stable(resolveNextStep(options)), before);
        }), /(?:Task timeline snapshot|Review artifact read snapshot|Invocation file observation changed|Invocation Windows ACL observation changed)/u, file);
        assert.deepEqual(stable(resolveNextStep(options)), before);
    }
});
