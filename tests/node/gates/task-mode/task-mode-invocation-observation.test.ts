import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { isPathRealpathInsideRoot } from '../../../../src/core/paths';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { getTaskModeEvidence } from '../../../../src/gates/task-mode/task-mode-evidence';
import { normalizeDirtyWorkspaceBaseline } from '../../../../src/gates/workspace/dirty-worktree-protection';

const TASK_ID = 'T-Q3-TASK-MODE';

function fixture(t: TestContext): { root: string; repo: string; artifact: string; runtime: string; live: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-mode-observation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    const runtime = path.join(repo, 'garda-agent-orchestrator/runtime');
    const live = path.join(repo, 'garda-agent-orchestrator/live');
    fs.mkdirSync(path.join(runtime, 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(runtime, 'task-events'), { recursive: true });
    fs.mkdirSync(live, { recursive: true });
    const artifact = path.join(runtime, 'reviews', TASK_ID + '-task-mode.json');
    writeJson(artifact, modernArtifact());
    return { root, repo, artifact, runtime, live };
}

function modernArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        task_id: TASK_ID, status: 'PASSED', outcome: 'PASS', event_source: 'enter-task-mode',
        entry_mode: 'EXPLICIT_TASK_EXECUTION', requested_depth: 2, effective_depth: 2,
        task_summary: 'Observe the task-mode evidence once', provider: 'Codex', routed_to: 'AGENTS.md',
        canonical_source_of_truth: 'Codex', execution_provider_source: 'provider_entrypoint',
        runtime_identity_status: 'resolved', planned_changed_files: ['src/source.ts'],
        dirty_workspace_baseline: { changed_files: ['src/source.ts'], file_hashes: { 'src/source.ts': 'abc' } },
        ...overrides
    };
}

function legacyArtifact(): Record<string, unknown> {
    const value = modernArtifact();
    delete value.canonical_source_of_truth;
    delete value.execution_provider_source;
    delete value.runtime_identity_status;
    return value;
}

function writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value) + '\n');
}

function measure(action: () => void): NextStepMeasurement {
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(action), value => { measurement = value; });
    return measurement!;
}

function junction(link: string, target: string): void {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

test('task-mode returns fresh mutable copies of private evidence and derives once at one and five consumers', t => {
    const state = fixture(t);
    const expected = getTaskModeEvidence(state.repo, TASK_ID);
    assert.equal(expected.evidence_status, 'PASS');
    for (const consumers of [1, 5]) {
        const measurement = measure(() => {
            let first: ReturnType<typeof getTaskModeEvidence> | undefined;
            for (let index = 0; index < consumers; index += 1) {
                const evidence = getTaskModeEvidence(state.repo, TASK_ID, index % 2 ? state.artifact : '');
                assert.deepEqual(evidence, expected);
                if (first) assert.notEqual(evidence, first);
                first = evidence;
                assert.equal(Object.isFrozen(evidence), false);
                assert.equal(Object.isFrozen(evidence.planned_changed_files), false);
                const normalized = normalizeDirtyWorkspaceBaseline(evidence.dirty_workspace_baseline, state.repo);
                assert.notEqual(normalized, evidence.dirty_workspace_baseline);
                assert.deepEqual(normalized, evidence.dirty_workspace_baseline);
                evidence.task_summary = 'Caller-owned changed summary';
                evidence.planned_changed_files.push('caller-owned.ts');
                evidence.dirty_workspace_baseline!.changed_files.push('caller-owned.ts');
                evidence.dirty_workspace_baseline!.file_hashes['src/source.ts'] = 'caller-owned';
                assert.deepEqual(getTaskModeEvidence(state.repo, TASK_ID), expected);
            }
        });
        assert.equal(measurement.work['derive:task_mode_evidence'], 1);
        assert.equal(measurement.work['derive:dirty_workspace_baseline'], 1);
        assert.equal(Object.entries(measurement.work).filter(([key]) =>
            key.toLowerCase() === ('file_hash:' + state.artifact).toLowerCase()).reduce((total, [, count]) => total + count, 0), 1);
    }
});

test('requested resolved artifact paths and task IDs are distinct invocation keys', t => {
    const state = fixture(t), other = path.join(state.runtime, 'reviews/other-task-mode.json');
    writeJson(other, modernArtifact({ task_summary: 'A distinct explicitly selected task-mode artifact' }));
    withInvocationReadObservation(() => {
        assert.equal(getTaskModeEvidence(state.repo, TASK_ID).evidence_status, 'PASS');
        assert.match(getTaskModeEvidence(state.repo, TASK_ID, other).task_summary || '', /distinct explicitly/u);
        assert.equal(getTaskModeEvidence(state.repo, 'T-DIFFERENT', state.artifact).evidence_status, 'EVIDENCE_TASK_MISMATCH');
        assert.equal(getTaskModeEvidence(state.repo, TASK_ID).task_summary, 'Observe the task-mode evidence once');
    });
});

test('the same artifact under different repository roots retains distinct legacy identity', t => {
    const state = fixture(t), nested = path.join(state.repo, 'nested');
    const sharedArtifact = path.join(nested, 'shared-task-mode.json');
    writeJson(sharedArtifact, legacyArtifact());
    writeJson(path.join(state.runtime, 'init-answers.json'), { SourceOfTruth: 'Codex' });
    const nestedRuntime = path.join(nested, 'garda-agent-orchestrator/runtime');
    fs.mkdirSync(path.join(nestedRuntime, 'task-events'), { recursive: true });
    writeJson(path.join(nestedRuntime, 'init-answers.json'), { SourceOfTruth: 'Claude' });
    withInvocationReadObservation(() => {
        const outerEvidence = getTaskModeEvidence(state.repo, TASK_ID, sharedArtifact);
        const innerEvidence = getTaskModeEvidence(nested, TASK_ID, sharedArtifact);
        assert.equal(outerEvidence.canonical_source_of_truth, 'Codex');
        assert.equal(innerEvidence.canonical_source_of_truth, 'Claude');
        assert.equal(outerEvidence.evidence_status, 'PASS');
        assert.equal(innerEvidence.evidence_status, 'PASS');
    });
});

test('task-mode never reuses a previous invocation after artifact content changes', t => {
    const state = fixture(t);
    const before = withInvocationReadObservation(() => getTaskModeEvidence(state.repo, TASK_ID));
    writeJson(state.artifact, modernArtifact({ task_summary: 'The next invocation observes new task evidence' }));
    const after = withInvocationReadObservation(() => getTaskModeEvidence(state.repo, TASK_ID));
    assert.notEqual(before.evidence_hash, after.evidence_hash);
    assert.match(after.task_summary || '', /next invocation/u);
});

test('same-byte task-mode path replacement returns one observation then fails the final check', t => {
    const state = fixture(t), bytes = fs.readFileSync(state.artifact);
    assert.throws(() => withInvocationReadObservation(() => {
        const before = getTaskModeEvidence(state.repo, TASK_ID);
        const replacement = state.artifact + '.replacement';
        fs.writeFileSync(replacement, bytes);
        fs.renameSync(replacement, state.artifact);
        assert.deepEqual(getTaskModeEvidence(state.repo, TASK_ID), before);
    }), /invocation|changed|snapshot/iu);
});

test('a missing task-mode artifact remains missing for consumers and its appearance rejects', t => {
    const state = fixture(t);
    fs.unlinkSync(state.artifact);
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(getTaskModeEvidence(state.repo, TASK_ID).evidence_status, 'EVIDENCE_FILE_MISSING');
        writeJson(state.artifact, modernArtifact());
        assert.equal(getTaskModeEvidence(state.repo, TASK_ID).evidence_status, 'EVIDENCE_FILE_MISSING');
    }), /invocation|changed|snapshot/iu);
});

test('invalid JSON and hard-linked task evidence keep their standalone rejection statuses', t => {
    const state = fixture(t);
    fs.writeFileSync(state.artifact, '{');
    const invalid = getTaskModeEvidence(state.repo, TASK_ID);
    assert.equal(invalid.evidence_status, 'EVIDENCE_INVALID_JSON');
    assert.deepEqual(withInvocationReadObservation(() => getTaskModeEvidence(state.repo, TASK_ID)), invalid);
    writeJson(state.artifact, modernArtifact());
    fs.linkSync(state.artifact, state.artifact + '.hard-link');
    const linked = getTaskModeEvidence(state.repo, TASK_ID);
    assert.equal(linked.evidence_status, 'EVIDENCE_FILE_MISSING');
    assert.deepEqual(withInvocationReadObservation(() => getTaskModeEvidence(state.repo, TASK_ID)), linked);
});

test('modern task evidence never captures unused legacy fallback files or absence', t => {
    const state = fixture(t), version = path.join(state.live, 'version.json');
    writeJson(version, { SourceOfTruth: 'Codex' });
    withInvocationReadObservation(() => {
        const evidence = getTaskModeEvidence(state.repo, TASK_ID);
        writeJson(path.join(state.runtime, 'init-answers.json'), { SourceOfTruth: 'Claude' });
        writeJson(version, { SourceOfTruth: 'Claude' });
        assert.deepEqual(getTaskModeEvidence(state.repo, TASK_ID), evidence);
        assert.equal(evidence.identity_backfilled_from_legacy, false);
    });
});

test('legacy init-answers absence is retained when version fallback is actually used', t => {
    const state = fixture(t);
    writeJson(state.artifact, legacyArtifact());
    writeJson(path.join(state.live, 'version.json'), { SourceOfTruth: 'Codex' });
    assert.throws(() => withInvocationReadObservation(() => {
        const evidence = getTaskModeEvidence(state.repo, TASK_ID);
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.identity_backfilled_from_legacy, true);
        writeJson(path.join(state.runtime, 'init-answers.json'), { SourceOfTruth: 'Claude' });
        assert.deepEqual(getTaskModeEvidence(state.repo, TASK_ID), evidence);
    }), /invocation|changed/iu);
});

test('valid init-answers avoids version fallback while malformed JSON keeps the native fallback', t => {
    const state = fixture(t), init = path.join(state.runtime, 'init-answers.json');
    const version = path.join(state.live, 'version.json');
    writeJson(state.artifact, legacyArtifact());
    writeJson(init, { SourceOfTruth: 'Codex' });
    writeJson(version, { SourceOfTruth: 'Claude' });
    withInvocationReadObservation(() => {
        assert.equal(getTaskModeEvidence(state.repo, TASK_ID).canonical_source_of_truth, 'Codex');
        writeJson(version, { SourceOfTruth: 'Gemini' });
    });
    fs.writeFileSync(init, '{');
    const expected = getTaskModeEvidence(state.repo, TASK_ID);
    assert.equal(expected.canonical_source_of_truth, 'Gemini');
    assert.deepEqual(withInvocationReadObservation(() => getTaskModeEvidence(state.repo, TASK_ID)), expected);
});

test('legacy version junction reads stay permissive and retained target swaps reject', t => {
    const state = fixture(t), first = path.join(state.root, 'first-version'), second = path.join(state.root, 'second-version');
    writeJson(state.artifact, legacyArtifact());
    writeJson(path.join(first, 'version.json'), { SourceOfTruth: 'Codex' });
    writeJson(path.join(second, 'version.json'), { SourceOfTruth: 'Codex' });
    fs.rmdirSync(state.live);
    junction(state.live, first);
    const expected = getTaskModeEvidence(state.repo, TASK_ID);
    assert.equal(expected.evidence_status, 'PASS');
    assert.deepEqual(withInvocationReadObservation(() => getTaskModeEvidence(state.repo, TASK_ID)), expected);
    assert.throws(() => withInvocationReadObservation(() => {
        const before = getTaskModeEvidence(state.repo, TASK_ID);
        fs.unlinkSync(state.live);
        junction(state.live, second);
        assert.deepEqual(getTaskModeEvidence(state.repo, TASK_ID), before);
    }), /invocation|changed/iu);
});

test('dirty baseline separates rootless, root-aware, and distinct-root projections', t => {
    const state = fixture(t), other = path.join(state.root, 'other-repo');
    const inside = path.join(state.repo, 'inside'), outside = path.join(state.root, 'outside');
    fs.mkdirSync(inside); fs.mkdirSync(outside); fs.mkdirSync(other);
    fs.writeFileSync(path.join(inside, 'source.ts'), 'inside');
    fs.writeFileSync(path.join(outside, 'source.ts'), 'outside');
    junction(path.join(state.repo, 'linked'), inside);
    junction(path.join(other, 'linked'), outside);
    const baseline = { changed_files: ['linked/source.ts', '../escape.ts'], staged_files: ['linked/source.ts'], file_hashes: {} };
    const expectations = [undefined, state.repo, other].map(repo => normalizeDirtyWorkspaceBaseline(baseline, repo));
    assert.deepEqual(expectations[0]?.changed_files, ['../escape.ts', 'linked/source.ts']);
    assert.deepEqual(expectations[1]?.changed_files, ['linked/source.ts']);
    assert.deepEqual(expectations[2]?.changed_files, []);
    const measurement = measure(() => {
        for (let consumer = 0; consumer < 5; consumer += 1) {
            for (const [index, repo] of [undefined, state.repo, other].entries()) {
                const actual = normalizeDirtyWorkspaceBaseline(baseline, repo);
                assert.deepEqual(actual, expectations[index]);
                assert.equal(Object.isFrozen(actual?.changed_files), false);
                actual!.changed_files.push('caller-only.ts');
                actual!.file_hashes['caller-only.ts'] = 'caller mutation';
                const next = normalizeDirtyWorkspaceBaseline(baseline, repo);
                assert.notEqual(next, actual);
                assert.deepEqual(next, expectations[index]);
            }
        }
    });
    assert.equal(measurement.work['derive:dirty_workspace_baseline'], 3);
    withInvocationReadObservation(() => {
        const callerCopy = normalizeDirtyWorkspaceBaseline(baseline, state.repo)!;
        callerCopy.changed_files.push('newly-selected.ts');
        callerCopy.file_hashes['newly-selected.ts'] = 'caller-selected-hash';
        const changedInput = normalizeDirtyWorkspaceBaseline(callerCopy, state.repo)!;
        assert.ok(changedInput.changed_files.includes('newly-selected.ts'));
        assert.equal(changedInput.file_hashes['newly-selected.ts'], 'caller-selected-hash');
        assert.deepEqual(normalizeDirtyWorkspaceBaseline(baseline, state.repo), expectations[1]);
    });
});

test('dirty baseline retains junction containment then rejects an escape before output', t => {
    const state = fixture(t), inside = path.join(state.repo, 'inside'), outside = path.join(state.root, 'outside');
    fs.mkdirSync(inside); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(inside, 'source.ts'), 'same');
    fs.writeFileSync(path.join(outside, 'source.ts'), 'same');
    const link = path.join(state.repo, 'linked');
    junction(link, inside);
    const baseline = { changed_files: ['linked/source.ts'], file_hashes: {} };
    assert.throws(() => withInvocationReadObservation(() => {
        const first = normalizeDirtyWorkspaceBaseline(baseline, state.repo);
        assert.deepEqual(first?.changed_files, ['linked/source.ts']);
        fs.unlinkSync(link); junction(link, outside);
        assert.deepEqual(normalizeDirtyWorkspaceBaseline(baseline, state.repo), first);
    }), /invocation|changed/iu);
    assert.deepEqual(normalizeDirtyWorkspaceBaseline(baseline, state.repo)?.changed_files, []);
});

test('dirty baseline observes missing descendants used by containment', t => {
    const state = fixture(t), file = path.join(state.repo, 'new-source.ts');
    const baseline = { changed_files: ['new-source.ts'], file_hashes: {} };
    assert.throws(() => withInvocationReadObservation(() => {
        const first = normalizeDirtyWorkspaceBaseline(baseline, state.repo);
        assert.deepEqual(first?.changed_files, ['new-source.ts']);
        fs.writeFileSync(file, 'created after normalization');
        assert.deepEqual(normalizeDirtyWorkspaceBaseline(baseline, state.repo), first);
    }), /invocation|changed/iu);
});


test('a newly authenticated task-mode cycle is observed by the next invocation', t => {
    const state = fixture(t), other = path.join(state.runtime, 'reviews/new-cycle-task-mode.json');
    const bundle = path.join(state.repo, 'garda-agent-orchestrator');
    writeJson(other, modernArtifact());
    appendTaskEvent(bundle, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Initial task-mode cycle.', {
        artifact_path: state.artifact.replace(/\\/gu, '/')
    });
    assert.equal(withInvocationReadObservation(() => getTaskModeEvidence(state.repo, TASK_ID)).evidence_status, 'PASS');
    appendTaskEvent(bundle, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'A new task-mode cycle selected another artifact.', {
        artifact_path: other.replace(/\\/gu, '/')
    });
    withInvocationReadObservation(() => {
        assert.equal(getTaskModeEvidence(state.repo, TASK_ID).evidence_status, 'EVIDENCE_ARTIFACT_PATH_MISMATCH');
        assert.equal(getTaskModeEvidence(state.repo, TASK_ID, other).evidence_status, 'PASS');
    });
});


test('deployed-bundle appearance cannot silently change the selected task-mode input', t => {
    const state = fixture(t), repo = path.join(state.root, 'unmaterialized-repo');
    const runtime = path.join(repo, 'runtime');
    fs.mkdirSync(path.join(runtime, 'task-events'), { recursive: true });
    writeJson(path.join(runtime, 'reviews', TASK_ID + '-task-mode.json'), modernArtifact());
    assert.throws(() => withInvocationReadObservation(() => {
        const before = getTaskModeEvidence(repo, TASK_ID);
        assert.equal(before.evidence_status, 'PASS');
        fs.mkdirSync(path.join(repo, 'garda-agent-orchestrator'));
        assert.deepEqual(getTaskModeEvidence(repo, TASK_ID), before);
    }), /path resolution changed|invocation.*changed/iu);
});


test('core containment keeps allowMissing projections separate and captures native realpaths once', t => {
    const state = fixture(t), directory = path.join(state.repo, 'contained');
    fs.mkdirSync(directory);
    const missing = path.join(directory, 'missing.ts');
    assert.equal(isPathRealpathInsideRoot(state.repo, missing), false);
    assert.equal(isPathRealpathInsideRoot(state.repo, missing, { allowMissing: true }), true);
    for (const consumers of [1, 5]) {
        const measurement = measure(() => {
            for (let index = 0; index < consumers; index += 1) {
                assert.equal(isPathRealpathInsideRoot(state.repo, missing), false);
                assert.equal(isPathRealpathInsideRoot(state.repo, missing, { allowMissing: true }), true);
            }
        });
        const initial = Object.entries(measurement.work).filter(([name]) => name.startsWith('native_realpath_observation:'));
        const final = Object.entries(measurement.work).filter(([name]) => name.startsWith('native_realpath_final_validation:'));
        assert.equal(initial.length, 2);
        assert.deepEqual(initial.map(([, count]) => count), [1, 1]);
        assert.equal(final.length, 2);
        assert.deepEqual(final.map(([, count]) => count), [1, 1]);
    }
});

test('core containment retains a negative junction-escape observation until final rejection', t => {
    const state = fixture(t), inside = path.join(state.repo, 'inside'), outside = path.join(state.root, 'outside');
    fs.mkdirSync(inside); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(inside, 'source.ts'), 'same');
    fs.writeFileSync(path.join(outside, 'source.ts'), 'same');
    const link = path.join(state.repo, 'linked'), candidate = path.join(link, 'source.ts');
    junction(link, outside);
    assert.equal(isPathRealpathInsideRoot(state.repo, candidate, { allowMissing: true }), false);
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(isPathRealpathInsideRoot(state.repo, candidate, { allowMissing: true }), false);
        fs.unlinkSync(link); junction(link, inside);
        assert.equal(isPathRealpathInsideRoot(state.repo, candidate, { allowMissing: true }), false);
    }), /invocation|changed/iu);
    assert.equal(isPathRealpathInsideRoot(state.repo, candidate, { allowMissing: true }), true);
});

test('core containment retains missing-root and missing-descendant dependencies', t => {
    const state = fixture(t), missingRoot = path.join(state.root, 'missing-root');
    const candidate = path.join(missingRoot, 'source.ts');
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(isPathRealpathInsideRoot(missingRoot, candidate), false);
        assert.equal(isPathRealpathInsideRoot(missingRoot, candidate, { allowMissing: true }), true);
        fs.mkdirSync(missingRoot);
        fs.writeFileSync(candidate, 'appeared after the absence observation');
        assert.equal(isPathRealpathInsideRoot(missingRoot, candidate), false);
    }), /invocation|changed/iu);
});

test('core containment uses native realpath output independently of the JS realpath observation', t => {
    const state = fixture(t), candidate = path.join(state.repo, 'source.ts'), outside = path.join(state.root, 'outside.ts');
    fs.writeFileSync(candidate, 'inside');
    fs.writeFileSync(outside, 'outside');
    const nativeRealpath = fs.realpathSync.native, originalJsRealpath = fs.realpathSync(candidate);
    t.mock.method(fs.realpathSync, 'native', ((file: fs.PathLike, ...options: unknown[]) => {
        if (path.resolve(String(file)) === candidate) return outside;
        return Reflect.apply(nativeRealpath, fs.realpathSync, [file, ...options]);
    }) as typeof nativeRealpath);
    assert.equal(fs.realpathSync(candidate), originalJsRealpath);
    assert.equal(isPathRealpathInsideRoot(state.repo, candidate), false);
    assert.equal(withInvocationReadObservation(() => isPathRealpathInsideRoot(state.repo, candidate)), false);
});

test('core containment preserves unchanged native errors and non-missing lstat error semantics', t => {
    const state = fixture(t), candidate = path.join(state.repo, 'source.ts');
    fs.writeFileSync(candidate, 'inside');
    const nativeFs = require('node:fs') as typeof fs;
    const nativeLstat = nativeFs.lstatSync, nativeRealpath = fs.realpathSync.native;
    const denied = Object.assign(new Error('fixture permission error'), { code: 'EACCES' });
    const statMock = t.mock.method(nativeFs, 'lstatSync', ((...args: unknown[]) => {
        if (path.resolve(String(args[0])) === candidate) throw denied;
        return Reflect.apply(nativeLstat, nativeFs, args);
    }) as typeof nativeLstat);
    // EACCES means an entry exists: native realpath still decides containment.
    assert.equal(isPathRealpathInsideRoot(state.repo, candidate), true);
    assert.equal(withInvocationReadObservation(() => isPathRealpathInsideRoot(state.repo, candidate)), true);
    statMock.mock.restore();
    t.mock.method(fs.realpathSync, 'native', ((file: fs.PathLike, ...options: unknown[]) => {
        if (path.resolve(String(file)) === candidate) throw denied;
        return Reflect.apply(nativeRealpath, fs.realpathSync, [file, ...options]);
    }) as typeof nativeRealpath);
    assert.equal(isPathRealpathInsideRoot(state.repo, candidate), false);
    assert.equal(withInvocationReadObservation(() => isPathRealpathInsideRoot(state.repo, candidate)), false);
});
