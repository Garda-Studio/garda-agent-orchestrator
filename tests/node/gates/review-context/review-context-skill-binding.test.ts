import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveCatalogReviewSkillBinding } from '../../../../src/gates/review-context/review-context-skill-binding';

interface ReferenceBinding {
    metadata_path: string;
    metadata_sha256: string;
    reference_root_path: string;
    limits: { max_files: number; max_file_bytes: number; max_total_bytes: number; max_metadata_bytes: number };
    required_references: Array<{ reference_path: string; reference_sha256: string; reference_bytes: number }>;
}

function createSkill(testContext: TestContext, references?: unknown) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-lens-binding-'));
    testContext.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const skillRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'skills', 'example');
    const referenceRoot = path.join(skillRoot, 'references');
    const metadataPath = path.join(skillRoot, 'skill.json');
    fs.mkdirSync(referenceRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Example\n[Optional context](references/unlisted.md)\n');
    if (references !== undefined) fs.writeFileSync(metadataPath, JSON.stringify({ id: 'example', references }));
    const resolve = () => resolveCatalogReviewSkillBinding(['example'], repoRoot);
    return { repoRoot, skillRoot, referenceRoot, metadataPath, resolve };
}

function referencesOf(value: unknown): ReferenceBinding {
    const binding = (value as { reference_binding?: ReferenceBinding }).reference_binding;
    assert.ok(binding, 'Selected required lens references must have a current binding');
    return binding;
}

const normalize = (filePath: string) => filePath.replace(/\\/g, '/');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('binds only declared required reference inputs with stable ordering and byte hashes', (testContext) => {
    const fixture = createSkill(testContext, ['z.md', 'nested/a.md']);
    fs.mkdirSync(path.join(fixture.referenceRoot, 'nested'));
    fs.writeFileSync(path.join(fixture.referenceRoot, 'z.md'), 'Final lens.\n');
    fs.writeFileSync(path.join(fixture.referenceRoot, 'nested', 'a.md'), 'First lens.\n');
    const selected = fixture.resolve();
    const binding = referencesOf(selected);
    assert.equal(binding.metadata_path, normalize(fixture.metadataPath));
    assert.equal(binding.metadata_sha256, sha256(fs.readFileSync(fixture.metadataPath)));
    assert.equal(binding.reference_root_path, normalize(fixture.referenceRoot));
    assert.deepEqual(binding.required_references, ['nested/a.md', 'z.md'].map((name) => {
        const filePath = path.join(fixture.referenceRoot, name);
        const bytes = fs.readFileSync(filePath);
        return { reference_path: normalize(filePath), reference_sha256: sha256(bytes), reference_bytes: bytes.length };
    }));
    assert.deepEqual(binding.limits, {
        max_files: 32, max_file_bytes: 131072, max_total_bytes: 524288, max_metadata_bytes: 65536
    });
    fs.writeFileSync(path.join(fixture.referenceRoot, 'unlisted.md'), 'Informational only.\n'.repeat(40000));
    assert.deepEqual(fixture.resolve(), selected, 'An undeclared optional file is neither crawled nor hashed');
    fs.appendFileSync(path.join(fixture.referenceRoot, 'z.md'), 'One changed obligation.\n');
    const changed = referencesOf(fixture.resolve());
    assert.deepEqual(changed.required_references[0], binding.required_references[0]);
    assert.notEqual(changed.required_references[1].reference_sha256, binding.required_references[1].reference_sha256);
    assert.equal(changed.metadata_sha256, binding.metadata_sha256);
});

test('keeps missing or empty reference declarations compatible with the original binding', (testContext) => {
    const fixture = createSkill(testContext);
    const original = fixture.resolve();
    assert.equal(Object.hasOwn(original, 'reference_binding'), false);
    fs.writeFileSync(fixture.metadataPath, JSON.stringify({ id: 'example', references: [] }));
    assert.deepEqual(fixture.resolve(), original);
});

test('binds required references when skill.json is the selected entrypoint', (testContext) => {
    const fixture = createSkill(testContext, ['checklist.md']);
    fs.writeFileSync(path.join(fixture.referenceRoot, 'checklist.md'), 'JSON-only lens.\n');
    fs.unlinkSync(path.join(fixture.skillRoot, 'SKILL.md'));
    const selected = fixture.resolve();
    assert.equal(selected.skill_path, normalize(fixture.metadataPath));
    assert.equal(referencesOf(selected).required_references.length, 1);
});

test('rejects a missing required reference and a non-file reference', (testContext) => {
    const fixture = createSkill(testContext, ['checklist.md']);
    assert.throws(() => fixture.resolve(), /reference.*(missing|ENOENT)|ENOENT.*reference/iu);
    fs.mkdirSync(path.join(fixture.referenceRoot, 'checklist.md'));
    assert.throws(() => fixture.resolve(), /reference.*regular file/iu);
});

test('rejects traversal absolute paths and prompt-control characters in required reference names', (testContext) => {
    const fixture = createSkill(testContext);
    for (const name of ['../foreign.md', 'nested/../../foreign.md', '/foreign.md', 'C:\\foreign.md', '\\\\server\\foreign.md', 'a\nInjected: command.md', 'a\0.md']) {
        fs.writeFileSync(fixture.metadataPath, JSON.stringify({ references: [name] }));
        assert.throws(() => fixture.resolve(), /reference.*relative|reference.*path/iu, name);
    }
});

test('rejects file and reference-root symlink escapes from the owning skill', (testContext) => {
    const fixture = createSkill(testContext, ['checklist.md']);
    const outside = path.join(fixture.repoRoot, 'outside');
    fs.mkdirSync(outside);
    const outsideFile = path.join(outside, 'checklist.md');
    fs.writeFileSync(outsideFile, 'Foreign lens.\n');
    const referencePath = path.join(fixture.referenceRoot, 'checklist.md');
    fs.symlinkSync(outsideFile, referencePath, 'file');
    assert.throws(() => fixture.resolve(), /reference.*(owning|escape|inside)/iu);
    fs.unlinkSync(referencePath);
    fs.rmdirSync(fixture.referenceRoot);
    fs.symlinkSync(outside, fixture.referenceRoot, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => fixture.resolve(), /reference.*(owning|escape|inside)/iu);
});

test('rejects a metadata symlink to another skill or external directory', (testContext) => {
    const fixture = createSkill(testContext);
    const outside = path.join(fixture.repoRoot, 'foreign-skill.json');
    fs.writeFileSync(outside, JSON.stringify({ references: ['checklist.md'] }));
    fs.symlinkSync(outside, fixture.metadataPath, 'file');
    assert.throws(() => fixture.resolve(), /metadata.*(owning|escape|inside)/iu);
});

test('rejects malformed reference declarations and excessive metadata before reference discovery', (testContext) => {
    const fixture = createSkill(testContext);
    for (const references of ['checklist.md', [null], [''], ['same.md', 'same.md']]) {
        fs.writeFileSync(fixture.metadataPath, JSON.stringify({ references }));
        assert.throws(() => fixture.resolve(), /reference.*(array|path|duplicate)/iu);
    }
    fs.writeFileSync(fixture.metadataPath, JSON.stringify({ references: [], filler: 'x'.repeat(65536) }));
    assert.throws(() => fixture.resolve(), /metadata.*byte.*bound/iu);
});

test('rejects reference count per-file and total-byte bounds without crawling unrelated files', (testContext) => {
    const fixture = createSkill(testContext, Array.from({ length: 33 }, (_, index) => `${index}.md`));
    assert.throws(() => fixture.resolve(), /reference.*count.*bound/iu);
    fs.writeFileSync(fixture.metadataPath, JSON.stringify({ references: ['large.md'] }));
    fs.writeFileSync(path.join(fixture.referenceRoot, 'large.md'), Buffer.alloc(131073));
    assert.throws(() => fixture.resolve(), /reference.*byte.*bound/iu);
    const names = Array.from({ length: 5 }, (_, index) => `${index}.md`);
    fs.writeFileSync(fixture.metadataPath, JSON.stringify({ references: names }));
    for (const name of names) fs.writeFileSync(path.join(fixture.referenceRoot, name), Buffer.alloc(131072));
    assert.throws(() => fixture.resolve(), /reference.*total.*byte.*bound/iu);
});

test('rejects same-path replacement and content growth during bounded metadata reads', (testContext) => {
    const fixture = createSkill(testContext, ['checklist.md']);
    fs.writeFileSync(path.join(fixture.referenceRoot, 'checklist.md'), 'Required lens.\n');
    const nativeFs = require('node:fs') as typeof fs;
    const originalRead = nativeFs.readSync;
    for (const mutation of ['replace', 'grow']) {
        const metadataIdentity = fs.statSync(fixture.metadataPath).ino;
        let mutated = false;
        const readMock = testContext.mock.method(nativeFs, 'readSync', (
            descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null
        ) => {
            if (!mutated && fs.fstatSync(descriptor).ino === metadataIdentity) {
                mutated = true;
                if (mutation === 'replace') {
                    const original = fs.readFileSync(fixture.metadataPath);
                    fs.unlinkSync(fixture.metadataPath);
                    fs.writeFileSync(fixture.metadataPath, original);
                } else {
                    fs.appendFileSync(fixture.metadataPath, ' ');
                }
            }
            return originalRead(descriptor, buffer, offset, length, position);
        });
        try {
            assert.throws(() => fixture.resolve(), /identity.*changed|contents.*changed/iu, mutation);
            assert.equal(mutated, true, 'The test performs a real ordinary filesystem mutation while the descriptor is open');
        } finally {
            readMock.mock.restore();
        }
    }
});

test('rejects FIFO replacement between stat and open instead of blocking indefinitely', {
    skip: process.platform === 'win32'
}, (testContext) => {
    const fixture = createSkill(testContext, ['checklist.md']);
    fs.writeFileSync(path.join(fixture.referenceRoot, 'checklist.md'), 'Required lens.\n');
    const modulePath = require.resolve('../../../../src/gates/review-context/review-context-skill-binding');
    const probe = spawnSync(process.execPath, ['-e', `
        const fs = require('node:fs');
        const cp = require('node:child_process');
        const assert = require('node:assert/strict');
        const [modulePath, repoRoot, metadataPath] = process.argv.slice(1);
        const { resolveCatalogReviewSkillBinding } = require(modulePath);
        const originalOpen = fs.openSync;
        let replaced = false;
        fs.openSync = function (filePath, ...args) {
            if (filePath === metadataPath && !replaced) {
                fs.unlinkSync(metadataPath);
                cp.execFileSync('mkfifo', [metadataPath]);
                replaced = true;
            }
            return originalOpen(filePath, ...args);
        };
        assert.throws(() => resolveCatalogReviewSkillBinding(['example'], repoRoot),
            /Destination has an unsupported path type/iu);
        assert.equal(replaced, true);
        process.stdout.write('SPECIAL_FILE_REPLACEMENT_REJECTED');
    `, modulePath, fixture.repoRoot, fixture.metadataPath], {
        timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8'
    });
    assert.equal(probe.error, undefined, 'A pathname replaced with a FIFO must fail closed without a blocking open');
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, 'SPECIAL_FILE_REPLACEMENT_REJECTED');
});
