import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRuleFileHashes, findStaleLoadedRuleFile } from '../../../../src/gates/rule-pack/rule-pack-selection';
import { fileSha256 } from '../../../../src/gates/shared/helpers';

test('regenerating the project-memory summary with only a new timestamp keeps loaded rules current', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-rule-hash-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const memory = path.join(root, 'live/docs/agent-rules/15-project-memory.md');
    fs.mkdirSync(path.dirname(memory), { recursive: true });
    const core = path.join(root, '00-core.md');
    const summary = (stamp: string, body: string) => `<!-- DO NOT EDIT -->\n\n# 15 · Project Memory Summary\n\nGenerated at: ${stamp}\n\n${body}\n`;
    fs.writeFileSync(memory, summary('2026-10-24T10:00:00.000Z', 'Stack: Java 25.'));
    fs.writeFileSync(core, '# Core\n');
    const loaded = buildRuleFileHashes([memory, core]);

    fs.writeFileSync(memory, summary('2026-10-25T00:00:20.251Z', 'Stack: Java 25.'));
    assert.equal(findStaleLoadedRuleFile(loaded, [memory, core]), null);

    fs.writeFileSync(memory, summary('2026-10-25T00:00:20.251Z', 'Stack: Java 25 and Next.js.'));
    assert.equal(findStaleLoadedRuleFile(loaded, [memory, core]), memory);

    fs.writeFileSync(memory, summary('2026-10-24T10:00:00.000Z', 'Stack: Java 25.'));
    fs.writeFileSync(core, '# Core changed\n');
    assert.equal(findStaleLoadedRuleFile(loaded, [memory, core]), core);

    // Evidence recorded before normalization (raw file hash) still matches an unchanged file.
    fs.writeFileSync(core, '# Core\n');
    assert.equal(findStaleLoadedRuleFile({ [memory]: fileSha256(memory), [core]: fileSha256(core) }, [memory, core]), null);
});

function hashFixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-rule-hash-boundary-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const memory = path.join(root, 'live/docs/agent-rules/15-project-memory.md');
    fs.mkdirSync(path.dirname(memory), { recursive: true });
    return { root, memory };
}

const strictSummary = (stamp: string) => `<!-- DO NOT EDIT -->\n\n# 15 · Project Memory Summary\n\nGenerated at: ${stamp}\n\n## Contract\n`;

test('only the canonical live rule path may ignore its generated timestamp', t => {
    const { root } = hashFixture(t);
    for (const file of ['15-project-memory.md', 'docs/agent-rules/15-project-memory.md', 'template/docs/agent-rules/15-project-memory.md']) {
        const copy = path.join(root, file);
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.writeFileSync(copy, strictSummary('2026-10-24T10:00:00.000Z'));
        const loaded = buildRuleFileHashes([copy]);
        fs.writeFileSync(copy, strictSummary('2026-10-25T10:00:00.000Z'));
        assert.equal(findStaleLoadedRuleFile(loaded, [copy]), copy, file);
    }
});

test('malformed generated-at text remains part of the rule evidence', t => {
    const { memory } = hashFixture(t);
    for (const stamp of ['manual security policy', '2026-10-24', '2026-10-24T10:00:00Z',
        '2026-10-24T10:00:00.000+00:00', '2026-10-24T10:00:00.000Z with extra rules']) {
        fs.writeFileSync(memory, strictSummary(stamp));
        const loaded = buildRuleFileHashes([memory]);
        fs.writeFileSync(memory, strictSummary(`${stamp} changed`));
        assert.equal(findStaleLoadedRuleFile(loaded, [memory]), memory, stamp);
    }
});

test('a strict generated-at line in the body cannot masquerade as generated header metadata', t => {
    const { memory } = hashFixture(t);
    const bodyOnly = (stamp: string) => `# 15 · Project Memory Summary\n\n## Contract\n\nGenerated at: ${stamp}\n`;
    fs.writeFileSync(memory, bodyOnly('2026-10-24T10:00:00.000Z'));
    const loaded = buildRuleFileHashes([memory]);
    fs.writeFileSync(memory, bodyOnly('2026-10-25T10:00:00.000Z'));
    assert.equal(findStaleLoadedRuleFile(loaded, [memory]), memory);
});

test('timestamp normalization preserves BOM, line endings and non-UTF8 body bytes exactly', t => {
    const { memory } = hashFixture(t);
    const stamp = '2026-10-24T10:00:00.000Z';
    const prefix = `\uFEFF${strictSummary(stamp).replace(/\n/gu, '\r\n')}`;
    const bytes = Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from([0xff]), Buffer.from('\r\n')]);
    fs.writeFileSync(memory, bytes);
    const loaded = buildRuleFileHashes([memory]);
    const expected = Buffer.concat([Buffer.from(prefix.replace(stamp, '1970-01-01T00:00:00.000Z'), 'utf8'), Buffer.from([0xff]), Buffer.from('\r\n')]);
    assert.equal(loaded[memory], createHash('sha256').update(expected).digest('hex'));
    const regenerated = Buffer.concat([Buffer.from(prefix.replace(stamp, '2026-10-25T10:00:00.000Z'), 'utf8'), Buffer.from([0xff]), Buffer.from('\r\n')]);
    fs.writeFileSync(memory, regenerated);
    assert.equal(findStaleLoadedRuleFile(loaded, [memory]), null);
    regenerated[regenerated.length - 3] = 0xfe;
    fs.writeFileSync(memory, regenerated);
    assert.equal(findStaleLoadedRuleFile(loaded, [memory]), memory, 'distinct invalid UTF-8 bytes must retain distinct hashes');
});


test('a loaded valid timestamp cannot collide with a malformed normalization marker', t => {
    const { memory } = hashFixture(t);
    fs.writeFileSync(memory, strictSummary('2026-10-24T10:00:00.000Z'));
    const loaded = buildRuleFileHashes([memory]);
    fs.writeFileSync(memory, strictSummary('<normalized>'));
    assert.equal(findStaleLoadedRuleFile(loaded, [memory]), memory);
    fs.writeFileSync(memory, strictSummary('1970-01-01T00:00:00.000Z'));
    assert.equal(findStaleLoadedRuleFile(loaded, [memory]), null);
});
