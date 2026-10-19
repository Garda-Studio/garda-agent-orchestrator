import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildManagedBlock,
    removeManagedBlock,
    upsertManagedBlock,
    findManagedSpan,
    extractManagedContent,
    extractUserContent,
    classifyOwnership
} from '../../../src/core/managed-blocks';

const START_MARKER = '<!-- managed-start -->';
const END_MARKER = '<!-- managed-end -->';

test('buildManagedBlock emits the expected marker envelope', () => {
    assert.equal(
        buildManagedBlock(START_MARKER, END_MARKER, ['one', 'two']),
        '<!-- managed-start -->\none\ntwo\n<!-- managed-end -->'
    );
});

test('upsertManagedBlock replaces an existing managed block in-place', () => {
    const initial = 'before\n<!-- managed-start -->\nold\n<!-- managed-end -->\nafter\n';
    const updated = upsertManagedBlock(initial, {
        startMarker: START_MARKER,
        endMarker: END_MARKER,
        blockLines: ['new']
    });

    assert.equal(updated, 'before\n<!-- managed-start -->\nnew\n<!-- managed-end -->\nafter\n');
});

test('removeManagedBlock strips the managed section and keeps surrounding text stable', () => {
    const initial = 'before\n<!-- managed-start -->\nmanaged\n<!-- managed-end -->\nafter\n';
    const updated = removeManagedBlock(initial, {
        startMarker: START_MARKER,
        endMarker: END_MARKER
    });

    assert.equal(updated, 'before\nafter\n');
});

test('upsertManagedBlock appends block when no managed section exists', () => {
    const result = upsertManagedBlock('existing content\n', {
        startMarker: START_MARKER,
        endMarker: END_MARKER,
        blockLines: ['added']
    });
    assert.equal(result, 'existing content\n<!-- managed-start -->\nadded\n<!-- managed-end -->\n');
});

test('upsertManagedBlock creates block from empty content', () => {
    const result = upsertManagedBlock('', {
        startMarker: START_MARKER,
        endMarker: END_MARKER,
        blockLines: ['fresh']
    });
    assert.equal(result, '<!-- managed-start -->\nfresh\n<!-- managed-end -->\n');
});

test('upsertManagedBlock creates block from whitespace-only content', () => {
    const result = upsertManagedBlock('   \n  \n', {
        startMarker: START_MARKER,
        endMarker: END_MARKER,
        blockLines: ['fresh']
    });
    assert.equal(result, '<!-- managed-start -->\nfresh\n<!-- managed-end -->\n');
});

test('upsertManagedBlock replaces multi-line managed block', () => {
    const initial = 'header\n<!-- managed-start -->\nline1\nline2\nline3\n<!-- managed-end -->\nfooter\n';
    const result = upsertManagedBlock(initial, {
        startMarker: START_MARKER,
        endMarker: END_MARKER,
        blockLines: ['replaced']
    });
    assert.equal(result, 'header\n<!-- managed-start -->\nreplaced\n<!-- managed-end -->\nfooter\n');
});

test('removeManagedBlock returns content unchanged when no managed block exists', () => {
    const content = 'no managed block here\n';
    const result = removeManagedBlock(content, {
        startMarker: START_MARKER,
        endMarker: END_MARKER
    });
    assert.equal(result, 'no managed block here\n');
});

test('removeManagedBlock handles block at start of content', () => {
    const initial = '<!-- managed-start -->\nmanaged\n<!-- managed-end -->\nafter\n';
    const result = removeManagedBlock(initial, {
        startMarker: START_MARKER,
        endMarker: END_MARKER
    });
    assert.equal(result, 'after\n');
});

test('removeManagedBlock handles block at end of content', () => {
    const initial = 'before\n<!-- managed-start -->\nmanaged\n<!-- managed-end -->\n';
    const result = removeManagedBlock(initial, {
        startMarker: START_MARKER,
        endMarker: END_MARKER
    });
    assert.equal(result, 'before\n');
});

test('upsertManagedBlock handles CRLF newline option', () => {
    const result = upsertManagedBlock('', {
        startMarker: START_MARKER,
        endMarker: END_MARKER,
        blockLines: ['crlf'],
        newline: '\r\n'
    });
    assert.equal(result, '<!-- managed-start -->\r\ncrlf\r\n<!-- managed-end -->\r\n');
});

test('removeManagedBlock handles CRLF input', () => {
    const initial = 'before\r\n<!-- managed-start -->\r\nmanaged\r\n<!-- managed-end -->\r\nafter\r\n';
    const result = removeManagedBlock(initial, {
        startMarker: START_MARKER,
        endMarker: END_MARKER,
        newline: '\r\n'
    });
    assert.equal(result, 'before\r\nafter\r\n');
});

test('removeManagedBlock collapses triple newlines at removal site', () => {
    const initial = 'before\n\n<!-- managed-start -->\nmanaged\n<!-- managed-end -->\n\nafter\n';
    const result = removeManagedBlock(initial, {
        startMarker: START_MARKER,
        endMarker: END_MARKER
    });
    assert.ok(!result.includes('\n\n\n'), 'should not contain triple newlines');
});

test('upsertManagedBlock with markers containing regex-special characters', () => {
    const start = '<!-- [start] ($) -->';
    const end = '<!-- [end] ($) -->';
    const initial = `header\n${start}\nold\n${end}\nfooter\n`;
    const result = upsertManagedBlock(initial, {
        startMarker: start,
        endMarker: end,
        blockLines: ['new']
    });
    assert.equal(result, `header\n${start}\nnew\n${end}\nfooter\n`);
});


test('findManagedSpan returns span indices for present markers', () => {
    const text = 'before\n<!-- managed-start -->\ncontent\n<!-- managed-end -->\nafter\n';
    const span = findManagedSpan(text, START_MARKER, END_MARKER, false);
    assert.ok(span, 'span should be defined');
    assert.equal(text.slice(span.start, span.end), '<!-- managed-start -->\ncontent\n<!-- managed-end -->');
});

test('findManagedSpan returns undefined when markers are absent', () => {
    const span = findManagedSpan('no markers here', START_MARKER, END_MARKER, false);
    assert.equal(span, undefined);
});

test('findManagedSpan with peripheral newlines extends span', () => {
    const text = 'before\n<!-- managed-start -->\ncontent\n<!-- managed-end -->\nafter\n';
    const span = findManagedSpan(text, START_MARKER, END_MARKER, true);
    assert.ok(span, 'span should be defined');
    assert.ok(span.start < text.indexOf(START_MARKER), 'span should extend before start marker');
    assert.ok(span.end > text.indexOf(END_MARKER) + END_MARKER.length, 'span should extend after end marker');
});


test('extractManagedContent returns managed block text', () => {
    const text = 'before\n<!-- managed-start -->\ncontent\n<!-- managed-end -->\nafter\n';
    const managed = extractManagedContent(text, START_MARKER, END_MARKER);
    assert.ok(managed, 'should extract managed content');
    assert.ok(managed.startsWith(START_MARKER));
    assert.ok(managed.endsWith(END_MARKER));
    assert.ok(managed.includes('content'));
});

test('extractManagedContent returns null when no markers', () => {
    const result = extractManagedContent('just user text', START_MARKER, END_MARKER);
    assert.equal(result, null);
});


test('extractUserContent returns text outside managed block', () => {
    const text = 'before\n<!-- managed-start -->\ncontent\n<!-- managed-end -->\nafter\n';
    const user = extractUserContent(text, START_MARKER, END_MARKER);
    assert.ok(user.includes('before'));
    assert.ok(user.includes('after'));
    assert.ok(!user.includes(START_MARKER));
    assert.ok(!user.includes(END_MARKER));
});

test('extractUserContent returns entire text when no markers', () => {
    const text = 'all user content';
    assert.equal(extractUserContent(text, START_MARKER, END_MARKER), text);
});


test('classifyOwnership returns single user region when no markers', () => {
    const regions = classifyOwnership('all user', START_MARKER, END_MARKER);
    assert.equal(regions.length, 1);
    assert.equal(regions[0].kind, 'user');
    assert.equal(regions[0].text, 'all user');
});

test('classifyOwnership returns user + managed + user for mixed content', () => {
    const text = 'before\n<!-- managed-start -->\ncontent\n<!-- managed-end -->\nafter';
    const regions = classifyOwnership(text, START_MARKER, END_MARKER);
    assert.equal(regions.length, 3);
    assert.equal(regions[0].kind, 'user');
    assert.equal(regions[1].kind, 'managed');
    assert.equal(regions[2].kind, 'user');
    assert.ok(regions[0].text.includes('before'));
    assert.ok(regions[1].text.includes(START_MARKER));
    assert.ok(regions[2].text.includes('after'));
});

test('classifyOwnership returns managed-only when entire content is managed', () => {
    const text = `${START_MARKER}\ncontent\n${END_MARKER}`;
    const regions = classifyOwnership(text, START_MARKER, END_MARKER);
    assert.equal(regions.length, 1);
    assert.equal(regions[0].kind, 'managed');
});

test('classifyOwnership returns empty array for empty text', () => {
    const regions = classifyOwnership('', START_MARKER, END_MARKER);
    assert.equal(regions.length, 0);
});

test('classifyOwnership regions cover full text without overlap', () => {
    const text = 'AAA\n<!-- managed-start -->\nBBB\n<!-- managed-end -->\nCCC';
    const regions = classifyOwnership(text, START_MARKER, END_MARKER);
    let reconstructed = '';
    for (const region of regions) {
        reconstructed += region.text;
    }
    assert.equal(reconstructed, text);
});

test('managed block mutations refuse orphaned, nested or reversed markers instead of deleting user text', () => {
    const options = { startMarker: '<!-- s -->', endMarker: '<!-- e -->', blockLines: ['managed'] };
    for (const content of [
        'user head\n<!-- s -->\nold\nuser text that must survive\n',
        'user\n<!-- e -->\nmiddle\n<!-- s -->\nold\n',
        '<!-- s -->\n<!-- s -->\nold\n<!-- e -->\n'
    ]) {
        assert.throws(() => upsertManagedBlock(content, options), /Ambiguous managed block markers/u);
        assert.throws(() => removeManagedBlock(content, options), /Ambiguous managed block markers/u);
    }
});

test('upsertManagedBlock keeps one block and user text when complete duplicate pairs exist', () => {
    const options = { startMarker: '<!-- s -->', endMarker: '<!-- e -->', blockLines: ['current'] };
    const content = 'head\n\n\nkeep\n<!-- s -->\nold-1\n<!-- e -->\nbetween\n<!-- s -->\nold-2\n<!-- e -->\ntail\n';
    const result = upsertManagedBlock(content, options);
    assert.equal(result.match(/<!-- s -->/gu)?.length, 1);
    assert.ok(result.startsWith('head\n\n\nkeep\n<!-- s -->\ncurrent\n<!-- e -->'));
    assert.ok(result.includes('between'));
    assert.ok(result.endsWith('tail\n'));
    assert.ok(!result.includes('old-'));
});
