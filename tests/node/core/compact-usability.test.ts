import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { compactPreview, compactTextPage, DEFAULT_COMPACT_SETTINGS, validateCompactSettings } from '../../../src/core/compact/contract';
import { CompactCapture, readCompactOutput, withCompactStore } from '../../../src/core/compact/store';
import { runCompactInspection } from '../../../src/core/compact/inspection';
import { handleCompact, parseCompactArguments } from '../../../src/cli/commands/compact-command';
import { applyCompactSettingOptions, compactSettingsFromConfig } from '../../../src/core/compact/setting-definitions';

function workspace(t: { after(fn: () => void): void }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-usability-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

async function retain(root: string, bytes: Buffer): Promise<string> {
    return withCompactStore(root, async store => {
        const capture = new CompactCapture(store, 'T-USABILITY', { ...DEFAULT_COMPACT_SETTINGS });
        await capture.write('stdout', bytes);
        return capture.finish({ exitCode: 0, timedOut: false, cancelled: false }).ref!;
    });
}

test('small multiline output is inline and explicit file ranges avoid second truncation', async t => {
    const root = workspace(t);
    const text = Array.from({ length: 80 }, (_, index) => `${index}: ordinary line`).join('\n') + '\n';
    assert.equal(compactPreview(text).omitted, false);
    fs.writeFileSync(path.join(root, 'small.txt'), text);
    const result = await runCompactInspection(root, 'T-USABILITY', { kind: 'file', path: 'small.txt', from: 1, lines: 80 });
    assert.equal(result.ref, undefined);
    assert.equal(result.source?.eof, true);
    assert.equal(result.source?.to, 80);
    const longer = 'a'.repeat(70) + '\n';
    fs.writeFileSync(path.join(root, 'range.txt'), longer.repeat(100));
    const selected = await runCompactInspection(root, 'T-USABILITY', { kind: 'file', path: 'range.txt', from: 10, lines: 80 });
    assert.equal(selected.ref, undefined);
    assert.equal(selected.source?.eof, false);
    assert.equal(selected.source?.from, 10);
    assert.equal(selected.source?.to, 89);
    assert.match(selected.stdout, /89: /);
});

test('byte pages preserve UTF-8 with continuation and bound escaped output', async t => {
    const root = workspace(t);
    const text = 'x'.repeat(4095) + 'Ж🙂'.repeat(2000) + '\nend';
    const ref = await retain(root, Buffer.from(text));
    let offset: number | null = 0;
    let restored = '';
    let calls = 0;
    do {
        const page = await readCompactOutput(root, { taskId: 'T-USABILITY', ref, stream: 'stdout', offset });
        restored += page.text;
        assert.ok(page.nextOffset === null || page.nextOffset > offset);
        offset = page.nextOffset;
        calls++;
    } while (offset !== null);
    assert.equal(restored, text);
    assert.ok(calls < Math.ceil(Buffer.byteLength(text) / 1024));
    const controls = compactTextPage(Buffer.alloc(8192, 0), 8192);
    assert.ok(controls.text.length <= 12000);
    assert.equal(controls.consumed, 3000);
    const invalid = compactTextPage(Buffer.from([0xff, 0x61, 0xc2, 0x62]), 256);
    assert.equal(invalid.consumed, 4);
    assert.equal(invalid.text, '\ufffda\ufffdb');
    assert.equal(compactTextPage(Buffer.from('valid \ufffd glyph'), 256).text, 'valid \ufffd glyph');
    const tail = await readCompactOutput(root, { taskId: 'T-USABILITY', ref, stream: 'stdout', tail: true });
    assert.ok(tail.text.endsWith('\nend'));
    assert.equal(tail.nextOffset, null);
    assert.ok(!tail.text.includes('\ufffd'));
    const controlsRef = await retain(root, Buffer.concat([Buffer.alloc(9000, 0), Buffer.from('last')]));
    const controlTail = await readCompactOutput(root, { taskId: 'T-USABILITY', ref: controlsRef, stream: 'stdout', tail: true, maxBytes: 8192 });
    assert.ok(controlTail.text.endsWith('last'));
    assert.ok(controlTail.text.length <= 12000);
    assert.equal(controlTail.nextOffset, null);
});

test('retained line ranges and larger pages remain validated when compact is disabled', async t => {
    const root = workspace(t);
    const text = Array.from({ length: 1000 }, (_, index) => `line-${index + 1}`).join('\n');
    const ref = await retain(root, Buffer.from(text));
    const config = path.join(root, 'garda-agent-orchestrator/live/config');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'workflow-config.json'), JSON.stringify({ compact: { enabled: false } }));
    const page = await readCompactOutput(root, { taskId: 'T-USABILITY', ref, stream: 'stdout', fromLine: 500, lines: 2, maxBytes: 8192 });
    assert.equal(page.text, 'line-500\nline-501\n');
    await assert.rejects(readCompactOutput(root, { taskId: 'T-USABILITY', ref, stream: 'stdout', fromLine: 2, offset: 0 }));
    await assert.rejects(readCompactOutput(root, { taskId: 'T-USABILITY', ref, stream: 'stdout', maxBytes: 8193 }));
});

test('multi-query search uses readable context and covers page boundaries', async t => {
    const root = workspace(t);
    const text = 'prefix\n' + 'a'.repeat(1024 * 1024 - 10) + 'boundary-needle\nhigh\nlow\nend';
    const ref = await retain(root, Buffer.from(text));
    const first = await readCompactOutput(root, { taskId: 'T-USABILITY', ref, stream: 'stdout', queries: ['boundary-needle', 'high', 'low'], context: 1 });
    assert.match(first.text, /boundary-needle/);
    assert.ok(first.nextOffset !== null);
    const second = await readCompactOutput(root, { taskId: 'T-USABILITY', ref, stream: 'stdout', queries: ['high', 'low'], offset: first.nextOffset!, context: 1 });
    assert.match(second.text, /high\nlow/);
    assert.equal(second.nextOffset, null);
    assert.ok(first.text.length <= 12000);
    await assert.rejects(readCompactOutput(root, { taskId: 'T-USABILITY', ref, stream: 'stdout', queries: [''], context: 1 }));
});

test('source scope survives retrieval and EOF is correct without final newline', async t => {
    const root = workspace(t);
    fs.writeFileSync(path.join(root, 'source.txt'), Array.from({ length: 200 }, (_, i) => `line-${i} ${'x'.repeat(90)}`).join('\n'));
    const result = await runCompactInspection(root, 'T-USABILITY', { kind: 'file', path: 'source.txt', from: 1, lines: 150 });
    assert.ok(result.ref);
    const page = await readCompactOutput(root, { taskId: 'T-USABILITY', ref: result.ref!, stream: 'stdout' });
    assert.deepEqual(page.source, { path: 'source.txt', from: 1, to: 150, eof: false });
    const end = await runCompactInspection(root, 'T-USABILITY', { kind: 'file', path: 'source.txt', from: 190, lines: 30 });
    assert.equal(end.source?.eof, true);
    assert.equal(end.source?.to, 200);
});

test('subcommand help needs no task, workspace or cache and query flags remain literal', async () => {
    const original = console.log;
    const output: string[] = [];
    console.log = value => { output.push(String(value)); };
    try {
        for (const args of [['--help'], ['file', '--help'], ['read', '--help'], ['search', '--help'], ['git', 'diff', '--help']]) await handleCompact(args);
    } finally { console.log = original; }
    assert.equal(output.length, 5);
    assert.ok(output.every(value => value.includes('--max-bytes')));
    assert.deepEqual(parseCompactArguments(['search', '--query', '--help', '--query', 'high']).queries, ['--help', 'high']);
    assert.throws(() => parseCompactArguments(['read', '--query', 'x']));
});

test('UI settings distinguish defaults from maxima without increasing cache caps', () => {
    const updated = applyCompactSettingOptions({}, { 'compact-preview-chars': '5000', 'compact-read-bytes': '8192', 'compact-search-context': '0' });
    const settings = compactSettingsFromConfig(updated.config);
    assert.equal(settings.previewChars, 5000);
    assert.equal(settings.readBytes, 8192);
    assert.equal(settings.searchContext, 0);
    assert.throws(() => validateCompactSettings({ workspaceBytes: DEFAULT_COMPACT_SETTINGS.workspaceBytes + 1 }));
});

test('multi-byte search pagination makes progress without repeating boundary matches', async t => {
    const root = workspace(t);
    const ref = await retain(root, Buffer.from(('Ж\n' + 'x'.repeat(100) + '\n').repeat(50)));
    let offset: number | null = 0;
    let pages = 0;
    const positions: number[] = [];
    do {
        const page = await readCompactOutput(root, { taskId: 'T-USABILITY', ref, stream: 'stdout', queries: ['Ж'], offset, context: 0 });
        positions.push(...[...page.text.matchAll(/byte (\d+);/g)].map(match => Number(match[1])));
        assert.ok(page.nextOffset === null || page.nextOffset > offset);
        offset = page.nextOffset;
        assert.ok(++pages < 10);
    } while (offset !== null);
    assert.equal(new Set(positions).size, 50);
    assert.equal(positions.length, 50);
});

test('escaped context never consumes the reserved space for a search match', async t => {
    const root = workspace(t);
    const text = Array.from({ length: 30 }, (_, index) => `${'a'.repeat(3000)}\n${'\x01'.repeat(512)}needle-${index};\n${'b'.repeat(3000)}\n`).join('');
    const ref = await retain(root, Buffer.from(text));
    let offset: number | null = 0;
    let output = '';
    let calls = 0;
    do {
        const page = await readCompactOutput(root, { taskId: 'T-USABILITY', ref, stream: 'stdout', queries: ['needle-'], offset, context: 1 });
        assert.ok(page.text.length <= 12000);
        output += page.text;
        assert.ok(page.nextOffset === null || page.nextOffset > offset);
        offset = page.nextOffset;
        assert.ok(++calls <= 30);
    } while (offset !== null);
    for (let index = 0; index < 30; index++) assert.ok(output.includes(`needle-${index};`), `undisclosed match ${index}`);
    const invalidRef = await retain(root, Buffer.concat([Buffer.alloc(20000, 0x80), Buffer.from('needle-invalid;\n')]));
    const invalid = await readCompactOutput(root, { taskId: 'T-USABILITY', ref: invalidRef, stream: 'stdout', queries: ['needle-invalid;'], context: 1 });
    assert.ok(invalid.text.includes('needle-invalid;'));
    assert.ok(invalid.text.length < 1000);
});
