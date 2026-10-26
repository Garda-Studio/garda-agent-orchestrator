import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withInvocationGitReadObservation } from '../../../../src/core/invocation-git-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { getClassificationConfig } from '../../../../src/gates/preflight/classify-change-config';
import { computeCodeReviewScopeFingerprint, computeReviewRelevantScopeFingerprint, computeReviewRelevantScopeWithoutCloseout,
    computeReviewReuseCodeScopeFingerprint, isReviewReuseNeutralWorkflowConfigChange } from '../../../../src/gates/review-reuse/review-reuse';

function fixture(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-scope-node-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function write(root: string, relative: string, value: string): string {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file;
}
function measured(action: () => void): NextStepMeasurement {
    let result: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(() => withInvocationGitReadObservation(action)), value => { result = value; });
    return result!;
}
function git(root: string, args: string[]): void {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
}

test('review lanes share common facts, preserve projections and return independent mutable results', t => {
    const root = fixture(t), files = ['src/main.ts', 'tests/main.test.ts', 'README.md', 'perf/bench.ts'];
    for (const file of files) write(root, file, file + '\n');
    const preflight = { task_id: 'T-SCOPE', changed_files: files, detection_source: 'explicit_changed_files' };
    const expected = [computeReviewReuseCodeScopeFingerprint('code', preflight, root),
        computeReviewReuseCodeScopeFingerprint('performance', preflight, root), computeReviewRelevantScopeFingerprint(preflight, root)];
    assert.notDeepEqual(expected[0], expected[1]);
    const result = measured(() => {
        for (let consumer = 0; consumer < 3; consumer += 1) {
            const code = computeReviewReuseCodeScopeFingerprint('code', preflight, root);
            assert.deepEqual(code, expected[0]); code.all_changed_files.push('mutated'); code.non_test_changed_files.length = 0;
            assert.deepEqual(computeReviewReuseCodeScopeFingerprint('performance', preflight, root), expected[1]);
            const relevant = computeReviewRelevantScopeFingerprint(preflight, root);
            assert.deepEqual(relevant, expected[2]); relevant.docs_only_changed_files.length = 0;
        }
    });
    assert.equal(result.work['derive:review_common_scope_facts'], 1);
    assert.equal(result.work['derive:review_code_scope_facts'], 1);
    assert.equal(result.work['derive:review_code_scope_projection'], 2);
    assert.equal(result.work['derive:review_relevant_scope_projection'], 1);
    assert.equal(result.work['derive:classification_config'], 1);
    assert.equal(result.work['derive:review_scope_file_fingerprint'], 3);
    assert.equal(result.work['file_hash:' + path.join(root, 'README.md')], undefined);
});

test('relevant-only scope keeps code facts lazy and closeout projections distinct', t => {
    const root = fixture(t), files = ['tests/main.test.ts', 'TASK.md'];
    for (const file of files) write(root, file, file + '\n');
    const preflight = { changed_files: files, detection_source: 'explicit_changed_files' };
    const expected = computeReviewRelevantScopeWithoutCloseout(preflight, root);
    const result = measured(() => {
        assert.deepEqual(computeReviewRelevantScopeWithoutCloseout(preflight, root), expected);
        assert.deepEqual(computeReviewRelevantScopeWithoutCloseout(preflight, root), expected);
        assert.deepEqual(computeReviewRelevantScopeFingerprint(preflight, root).all_changed_files, files);
        assert.deepEqual(expected.all_changed_files, ['tests/main.test.ts']);
    });
    assert.equal(result.work['derive:review_code_scope_facts'], undefined);
    assert.equal(result.work['derive:review_without_closeout_scope'], 1);
});

test('scope keys bind mutable preflight, explicit configuration and staged-map values', t => {
    const root = fixture(t); write(root, 'src/main.ts', 'worktree'); write(root, 'src/other.ts', 'other');
    const config = getClassificationConfig(root);
    const preflight = { changed_files: ['src/main.ts'], detection_source: 'git_staged_only' };
    const staged = new Map([['src/main.ts', 'stage:100644:aaa']]);
    withInvocationReadObservation(() => {
        const initial = computeReviewRelevantScopeFingerprint(preflight, root, config, staged);
        staged.set('src/main.ts', 'stage:100644:bbb');
        assert.notEqual(computeReviewRelevantScopeFingerprint(preflight, root, config, staged).review_scope_sha256, initial.review_scope_sha256);
        preflight.detection_source = 'explicit_changed_files';
        assert.notEqual(computeReviewRelevantScopeFingerprint(preflight, root, config, staged).review_scope_sha256, initial.review_scope_sha256);
        preflight.changed_files.push('src/other.ts');
        assert.equal(computeReviewRelevantScopeFingerprint(preflight, root, config, staged).all_changed_files.length, 2);
        config.file_roles = { 'src/main.ts': 'test', 'src/other.ts': 'test' };
        assert.equal(computeReviewReuseCodeScopeFingerprint('code', preflight, root, config, staged).test_only, true);
        config.file_roles = { 'src/main.ts': 'source', 'src/other.ts': 'source' };
        assert.equal(computeReviewReuseCodeScopeFingerprint('code', preflight, root, config, staged).test_only, false);
    });
});

test('classification config remains mutable publicly and rejects changed or newly created dependencies', t => {
    const root = fixture(t), relative = 'garda-agent-orchestrator/live/config/paths.json';
    const file = write(root, relative, '{}');
    const expected = getClassificationConfig(root);
    assert.throws(() => withInvocationReadObservation(() => {
        const first = getClassificationConfig(root); first.runtime_roots.length = 0;
        assert.deepEqual(getClassificationConfig(root), expected);
        fs.writeFileSync(file, '{"runtime_roots":["different/"]}');
        assert.deepEqual(getClassificationConfig(root), expected);
    }), /Invocation .*changed/u);
    fs.unlinkSync(file);
    assert.throws(() => withInvocationReadObservation(() => {
        getClassificationConfig(root); fs.writeFileSync(file, '{}');
    }), /Invocation .*changed/u);
});

test('neutral workflow comparison observes its selected worktree bytes until invocation exit', t => {
    const root = fixture(t), relative = 'garda-agent-orchestrator/live/config/workflow-config.json';
    const file = write(root, relative, '{"review_cycle_guard":{"max_total_non_test_reviews":5}}');
    git(root, ['init', '-q']); git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Scope Test', '-c', 'user.email=scope@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline']);
    fs.writeFileSync(file, '{"review_cycle_guard":{"max_total_non_test_reviews":9}}');
    const preflight = { changed_files: [relative], detection_source: 'explicit_changed_files' };
    assert.equal(isReviewReuseNeutralWorkflowConfigChange(preflight, root, relative), true);
    assert.throws(() => withInvocationReadObservation(() => withInvocationGitReadObservation(() => {
        assert.equal(computeReviewRelevantScopeFingerprint(preflight, root).review_reuse_neutral_config_files.length, 1);
        fs.writeFileSync(file, '{"review_cycle_guard":{"max_total_non_test_reviews":10}}');
        assert.equal(computeReviewRelevantScopeFingerprint(preflight, root).review_reuse_neutral_config_files.length, 1);
    })), /Invocation .*changed/u);
});


test('scope and classification memo keys never evaluate irrelevant accessors or toJSON', t => {
    const root = fixture(t); write(root, 'src/main.ts', 'source');
    let getterCalls = 0, serializationCalls = 0;
    const preflight = { changed_files: ['src/main.ts'], detection_source: 'explicit_changed_files' };
    Object.defineProperty(preflight, 'irrelevant', { enumerable: true, get() { getterCalls++; throw new Error('irrelevant getter'); } });
    Object.defineProperty(preflight, 'toJSON', { enumerable: true, value() { serializationCalls++; throw new Error('caller toJSON'); } });
    const options = {};
    Object.defineProperty(options, 'irrelevant', { enumerable: true, get() { getterCalls++; throw new Error('irrelevant option getter'); } });
    Object.defineProperty(options, 'toJSON', { enumerable: true, value() { serializationCalls++; throw new Error('options toJSON'); } });
    const expectedCode = computeCodeReviewScopeFingerprint(preflight, root);
    const expectedRelevant = computeReviewRelevantScopeFingerprint(preflight, root);
    const expectedConfig = getClassificationConfig(root, options);
    withInvocationReadObservation(() => {
        assert.deepEqual(computeCodeReviewScopeFingerprint(preflight, root), expectedCode);
        assert.deepEqual(computeReviewRelevantScopeFingerprint(preflight, root), expectedRelevant);
        assert.deepEqual(getClassificationConfig(root, options), expectedConfig);
    });
    assert.equal(getterCalls, 0); assert.equal(serializationCalls, 0);
});

test('opaque preflight proxies retain native property-access behavior', t => {
    const root = fixture(t); write(root, 'src/main.ts', 'source');
    const run = (observed: boolean) => {
        const traps: string[] = [];
        const preflight = new Proxy({ changed_files: ['src/main.ts'], detection_source: 'explicit_changed_files' }, {
            get(target, key, receiver) { traps.push('get:' + String(key)); return Reflect.get(target, key, receiver); },
            ownKeys(target) { traps.push('ownKeys'); return Reflect.ownKeys(target); },
            getOwnPropertyDescriptor(target, key) { traps.push('descriptor:' + String(key)); return Reflect.getOwnPropertyDescriptor(target, key); }
        });
        const action = () => computeReviewRelevantScopeFingerprint(preflight, root);
        const result = observed ? withInvocationReadObservation(action) : action();
        return { result, traps };
    };
    assert.deepEqual(run(true), run(false));
});

test('custom staged get remains native and no added iterator is invoked', t => {
    const root = fixture(t);
    const config = getClassificationConfig(root);
    const preflight = { changed_files: ['src/main.ts'], detection_source: 'git_staged_only' };
    const run = (observed: boolean) => {
        let reads = 0, iterations = 0;
        const staged = new Map<string, string>();
        Object.defineProperty(staged, 'get', { value: () => 'stage:100644:custom-' + (++reads) });
        Object.defineProperty(staged, Symbol.iterator, { value: () => { iterations++; throw new Error('native scope never iterates an explicit map'); } });
        const action = () => [computeReviewRelevantScopeFingerprint(preflight, root, config, staged).review_scope_sha256,
            computeReviewRelevantScopeFingerprint(preflight, root, config, staged).review_scope_sha256];
        const hashes = observed ? withInvocationReadObservation(action) : action();
        assert.notEqual(hashes[0], hashes[1]);
        return { hashes, reads, iterations };
    };
    assert.deepEqual(run(true), run(false));
    assert.equal(run(true).iterations, 0);
});
