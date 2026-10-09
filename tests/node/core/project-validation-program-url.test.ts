import { it } from 'node:test';
import assert from 'node:assert/strict';
import { rejectInlineValidationProgramUrl } from '../../../src/core/project-validation-program-url';

for (const scheme of ['data:text/javascript,code', 'javascript:code']) {
    for (const role of [true, false]) {
        for (const codePoint of [null, ...Array.from({ length: 33 }, (_, index) => index)]) {
            const input = codePoint === null ? scheme : `${String.fromCharCode(codePoint)}${scheme}`;
            it(`rejects an inline program URL, program=${role}, prefix=${codePoint}`, () => {
                assert.throws(() => rejectInlineValidationProgramUrl(input, role), /Inline program URLs/u);
            });
        }
    }
}

for (const input of ['da\tta:text/javascript,code', 'da\nta:code', 'da\rta:code',
    'java\tscript:code', 'java\nscript:code', 'java\rscript:code', 'DATA:code\r\n']) {
    it(`rejects a URL with parser-normalized characters ${JSON.stringify(input)}`, () => {
        assert.throws(() => rejectInlineValidationProgramUrl(input, true), /Inline program URLs/u);
    });
}

for (const input of ['--loader=data:code', '--loader= data:code', '--loader=\u0001data:code',
    '--import=java\tscript:code', '--loader=\r\ndata:code', '--loader=data:payload=literal']) {
    it(`rejects inline URL option data ${JSON.stringify(input)}`, () => {
        assert.throws(() => rejectInlineValidationProgramUrl(input, false), /Inline program URLs/u);
    });
}

for (const input of ['scripts/check.js', './data:literal', 'scripts/check=data:literal',
    'scripts/check=javascript:literal', 'file:///tmp/check.any', 'https://example.invalid/check.any',
    'custom-project:declaration', '', '\u0085data:literal', '\u00a0data:literal', '\uFEFFdata:literal']) {
    it(`keeps literal or other-scheme data unapproved ${JSON.stringify(input)}`, () => {
        assert.equal(rejectInlineValidationProgramUrl(input, true), undefined);
    });
}

for (const input of ['--loader=data:literal', '=javascript:literal', 'file=data:literal']) {
    it(`preserves assignment text inside a program filename ${JSON.stringify(input)}`, () => {
        assert.equal(rejectInlineValidationProgramUrl(input, true), undefined);
    });
}

for (const input of ['--loader=scripts/check=data:literal', '--loader=file:///tmp/check.any',
    '--option=value=javascript:literal', 'scripts/check=data:literal']) {
    it(`preserves literal option values after their first assignment boundary ${JSON.stringify(input)}`, () => {
        assert.equal(rejectInlineValidationProgramUrl(input, false), undefined);
    });
}

it('rejects nonliteral data without invoking object coercion', () => {
    let coerced = false;
    const data = { toString() { coerced = true; return 'data:code'; } };
    assert.throws(() => Reflect.apply(rejectInlineValidationProgramUrl, undefined, [data, true]), /literal/u);
    assert.equal(coerced, false);
});

for (const role of [undefined, null, 0, 'false', {}]) {
    it(`rejects a forged nonboolean role ${JSON.stringify(role)}`, () => {
        assert.throws(() => Reflect.apply(rejectInlineValidationProgramUrl, undefined, ['--loader=data:code', role]), /literal/u);
    });
}
