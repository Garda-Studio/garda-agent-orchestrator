import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasSkillEntrypoint } from '../../../../src/core/review-capabilities';
import { withInvocationReadObservation } from '../../../../src/core/invocation-read-observation';
import { withNextStepMeasurement, type NextStepMeasurement } from '../../../../src/core/next-step-measurement';
import { resolveCatalogReviewSkillBinding } from '../../../../src/gates/review-context/review-context-skill-binding';

function createSkill(t: TestContext, references?: string[]) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-skill-observation-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const skillsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'skills');
    const skillRoot = path.join(skillsRoot, 'example');
    const referenceRoot = path.join(skillRoot, 'references');
    const metadataPath = path.join(skillRoot, 'skill.json');
    const entrypoint = path.join(skillRoot, 'SKILL.md');
    fs.mkdirSync(referenceRoot, { recursive: true });
    fs.writeFileSync(entrypoint, '# Example\n');
    if (references) {
        fs.writeFileSync(metadataPath, JSON.stringify({ references }));
        for (const name of references) fs.writeFileSync(path.join(referenceRoot, name), 'Required lens.\n');
    }
    const resolve = (candidates = ['example']) => resolveCatalogReviewSkillBinding(candidates, repoRoot);
    return { repoRoot, skillsRoot, skillRoot, referenceRoot, metadataPath, entrypoint, resolve };
}

function measured(action: () => void): NextStepMeasurement {
    let measurement: NextStepMeasurement | undefined;
    withNextStepMeasurement(() => withInvocationReadObservation(action), value => { measurement = value; });
    return measurement!;
}

test('memoizes checked bounded bytes at one and five consumers and preserves mutable result copies', t => {
    const fixture = createSkill(t, ['checklist.md']);
    const expected = fixture.resolve();
    const nativeFs = require('node:fs') as typeof fs;
    const nativeRead = nativeFs.readSync;
    const boundedFiles = [fixture.metadataPath, path.join(fixture.referenceRoot, 'checklist.md')];
    const identities = boundedFiles.map(file => fs.statSync(file).ino);
    let reads: number[] = [];
    const readMock = t.mock.method(nativeFs, 'readSync', (
        descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null
    ) => {
        const count = nativeRead(descriptor, buffer, offset, length, position);
        const index = identities.indexOf(fs.fstatSync(descriptor).ino);
        if (count > 0 && index >= 0) reads[index] += 1;
        return count;
    });
    try {
        for (const lanes of [1, 5]) {
            reads = [0, 0];
            const measurement = measured(() => {
                for (let lane = 0; lane < lanes; lane += 1) {
                    const binding = fixture.resolve();
                    assert.deepEqual(binding, expected);
                    assert.equal(Object.isFrozen(binding), false);
                    binding.candidate_skill_ids.push('caller-only');
                    binding.reference_binding!.required_references[0].reference_sha256 = 'caller-only';
                }
            });
            assert.deepEqual(reads, [2, 2], 'One strict descriptor read and one shared Q2 content capture per bounded input');
            const hashes = Object.entries(measurement.work).filter(([name]) => name.startsWith('file_hash:'));
            assert.equal(hashes.length, 3);
            assert.ok(hashes.every(([, count]) => count === 1));
        }
    } finally { readMock.mock.restore(); }
});

test('retains consumed candidate absence until the final check rejects a new preferred entrypoint', t => {
    const fixture = createSkill(t);
    const preferred = path.join(fixture.skillsRoot, 'preferred');
    assert.throws(() => withInvocationReadObservation(() => {
        const first = fixture.resolve(['preferred', 'example']);
        assert.equal(first.skill_id, 'example');
        fs.mkdirSync(preferred);
        fs.writeFileSync(path.join(preferred, 'SKILL.md'), '# Preferred\n');
        assert.deepEqual(fixture.resolve(['preferred', 'example']), first);
    }), /Invocation.*changed/iu);
    assert.equal(fixture.resolve(['preferred', 'example']).skill_id, 'preferred');
});

test('retains consumed non-file entrypoint kind and rejects its replacement by a file', t => {
    const fixture = createSkill(t);
    const preferred = path.join(fixture.skillsRoot, 'preferred');
    const entrypoint = path.join(preferred, 'SKILL.md');
    fs.mkdirSync(entrypoint, { recursive: true });
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(fixture.resolve(['preferred', 'example']).skill_id, 'example');
        fs.rmdirSync(entrypoint);
        fs.writeFileSync(entrypoint, '# Preferred\n');
    }), /Invocation.*changed/iu);
});

test('registers optional metadata absence even when the markdown entrypoint already exists', t => {
    const fixture = createSkill(t);
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(fixture.resolve().reference_binding, undefined);
        fs.writeFileSync(fixture.metadataPath, JSON.stringify({ references: [] }));
        assert.equal(fixture.resolve().reference_binding, undefined);
    }), /Invocation.*changed/iu);
});

test('does not observe candidates after selection or undeclared optional reference files', t => {
    const fixture = createSkill(t, ['required.md']);
    withInvocationReadObservation(() => {
        const first = fixture.resolve(['example', 'unused']);
        const unused = path.join(fixture.skillsRoot, 'unused');
        fs.mkdirSync(unused);
        fs.writeFileSync(path.join(unused, 'SKILL.md'), '# Unused\n');
        fs.writeFileSync(path.join(fixture.referenceRoot, 'optional.md'), 'Not declared.\n');
        assert.deepEqual(fixture.resolve(['example', 'unused']), first);
    });
});

test('registers selected entrypoint, metadata and required-reference byte changes independently', t => {
    for (const input of ['entrypoint', 'metadata', 'reference']) {
        const fixture = createSkill(t, ['required.md']);
        const file = input === 'entrypoint' ? fixture.entrypoint
            : input === 'metadata' ? fixture.metadataPath : path.join(fixture.referenceRoot, 'required.md');
        assert.throws(() => withInvocationReadObservation(() => {
            const first = fixture.resolve();
            fs.appendFileSync(file, ' ');
            assert.deepEqual(fixture.resolve(), first);
        }), /Invocation.*changed/iu, input);
    }
});

test('rejects same-byte required-reference replacement and reference-root junction substitution', t => {
    for (const replacement of ['file', 'root']) {
        const fixture = createSkill(t, ['required.md']);
        const reference = path.join(fixture.referenceRoot, 'required.md');
        const bytes = fs.readFileSync(reference);
        const outside = path.join(fixture.repoRoot, 'outside');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'required.md'), bytes);
        assert.throws(() => withInvocationReadObservation(() => {
            fixture.resolve();
            if (replacement === 'file') {
                const temporary = path.join(fixture.referenceRoot, 'replacement.md');
                fs.writeFileSync(temporary, bytes);
                fs.renameSync(temporary, reference);
            } else {
                fs.renameSync(fixture.referenceRoot, fixture.referenceRoot + '-original');
                fs.symlinkSync(outside, fixture.referenceRoot, process.platform === 'win32' ? 'junction' : 'dir');
            }
        }), /Invocation.*changed/iu, replacement);
    }
});

test('preserves strict bounded reader errors for unchanged invalid inputs inside an invocation', t => {
    for (const invalid of ['oversize', 'missing', 'directory', 'escape']) {
        const fixture = createSkill(t, ['required.md']);
        const reference = path.join(fixture.referenceRoot, 'required.md');
        if (invalid === 'oversize') fs.writeFileSync(reference, Buffer.alloc(131073));
        else {
            fs.unlinkSync(reference);
            if (invalid === 'directory') fs.mkdirSync(reference);
            if (invalid === 'escape') {
                const outside = path.join(fixture.repoRoot, 'outside.md');
                fs.writeFileSync(outside, 'Outside.\n');
                fs.symlinkSync(outside, reference, 'file');
            }
        }
        let original: Error | undefined;
        try { fixture.resolve(); } catch (error) { original = error as Error; }
        assert.ok(original);
        withInvocationReadObservation(() => {
            assert.throws(() => fixture.resolve(), (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.message, original!.message);
                return true;
            });
        });
    }
});

test('hasSkillEntrypoint records absence and preserves lazy markdown versus JSON selection', t => {
    const fixture = createSkill(t);
    withInvocationReadObservation(() => {
        assert.equal(hasSkillEntrypoint(fixture.skillRoot), true);
        fs.writeFileSync(fixture.metadataPath, 'Unused by the entrypoint predicate.\n');
        assert.equal(hasSkillEntrypoint(fixture.skillRoot), true);
    });
    const absent = path.join(fixture.skillsRoot, 'absent');
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(hasSkillEntrypoint(absent), false);
        fs.mkdirSync(absent);
        fs.writeFileSync(path.join(absent, 'skill.json'), '{}');
        assert.equal(hasSkillEntrypoint(absent), false);
    }), /Invocation.*changed/iu);
    assert.equal(hasSkillEntrypoint(absent), true);
});
