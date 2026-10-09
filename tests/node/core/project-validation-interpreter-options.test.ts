import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseValidationInterpreterPrefix, normalizeValidationInterpreterOption } from '../../../src/core/project-validation-interpreter-options';

type BoundaryCase = readonly [string, readonly string[], number, readonly number[]];
const fileBoundaries: BoundaryCase[] = [
    ['ruby', ['-rbundler/setup', 'check.rb', '-e', 'javascript:literal'], 1, []],
    ['ruby', ['-r', 'bundler/setup', 'check.rb', '-e', 'literal'], 2, []],
    ['ruby', ['-wrbundler/setup', 'check.rb', '-e'], 1, []],
    ['ruby', ['-I', 'javascript:directory', 'check.rb', '-e'], 2, [1]],
    ...['-0777', '-W2', '-Ke', '-d0777w'].map((flag): BoundaryCase => ['ruby', [flag, 'check.rb', '-e'], 1, []]),
    ['node', ['--require', 'bootstrap.js', 'check.js', '--eval=literal'], 2, []],
    ['node', ['--import=javascript:code', 'check.js', '--eval=literal'], 1, []],
    ['node', ['--conditions', 'javascript:debug', 'check.js'], 2, [1]],
    ['node', ['--conditions=javascript:debug', 'check.js'], 1, [0]],
    ['python', ['-IX', '-c', 'check.py', '-c'], 2, [1]],
    ['python', ['-IW', 'javascript:debug', 'check.py'], 2, [1]],
    ['python', ['-Xsetting=javascript:debug', 'check.py'], 1, [0]],
    ['python', ['-Wonce', 'check.py'], 1, [0]],
    ['python', ['-I', '-m', 'suite.cli', '-c'], 2, []],
    ['python', ['-mpackage.m', 'javascript:literal'], 0, []],
    ...['-Itest', '-MFile::Spec', '-mFile::Spec', '-Mlib=left,right', '-wItest', '-Ftext', '-i.bak'].map((flag): BoundaryCase =>
        ['perl', [flag, 'check.pl', '-e'], 1, [0]]),
    ['perl', ['-I', 'javascript:directory', 'check.pl', '-e'], 2, [1]],
    ['perl', ['-M', 'File::Spec', 'check.pl', '-e'], 2, [1]],
    ...['-0', '-0777', '-0x1E', '-l012', '-nw', '-pw'].map((flag): BoundaryCase => ['perl', [flag, 'check.pl', '-e'], 1, []]),
    ['php', ['-CneH', 'check.php', '-r', 'literal'], 1, []],
    ['pwsh', ['-NoProfile', '-File', 'check.ps1', '-Command'], 2, []],
    ['powershell', ['-File', 'check.ps1', '-Command'], 1, []],
    ['deno', ['run', 'check.ts', 'eval'], 1, []],
    ['node', ['--', '-check.js', '--eval=literal'], 1, []],
    ...['bash', 'sh', 'zsh'].flatMap((tool): BoundaryCase[] => [
        [tool, ['-eo', 'errexit', 'check.sh', '-c'], 2, [1]],
        [tool, ['-ex', 'check.sh', '-s'], 1, []],
        [tool, ['+e', 'check.sh', '-c'], 1, []]
    ]),
    ['zsh', ['-onoclobber', 'check.sh', '-c'], 1, [0]]
];
for (const [tool, arguments_, programIndex, literalValueIndices] of fileBoundaries) {
    it(`preserves the program boundary for ${tool} ${arguments_.join(' ')}`, () => {
        const argv = Object.freeze([...arguments_]);
        const result = parseValidationInterpreterPrefix(tool, argv);
        assert.equal(result.programIndex, programIndex);
        assert.deepEqual(result.literalValueIndices, literalValueIndices);
        assert.deepEqual(argv, arguments_);
    });
}
const unresolved: readonly (readonly [string, readonly string[]])[] = [
    ['ruby', ['-0777e', 'puts 1']], ['php', ['-nr', 'echo 1;']],
    ['perl', ['-0x1EpE', 'print 1']], ['node', ['--unknown', 'value', '--eval=code']],
    ['node', ['--unknown=value', 'operand', '--eval=code']],
    ...['bash', 'sh', 'zsh'].flatMap((tool): (readonly [string, readonly string[]])[] =>
        ['-c', '-xc', '-ec', '-s', '-xs', '-es', '-Z', '+Z'].map((flag) => [tool, [flag, 'echo 1', 'check.sh']])),
    ...['bash', 'sh'].map((tool): readonly [string, readonly string[]] => [tool, ['-onoclobber', 'check.sh', '-c']]),
    ...['bash', 'sh', 'zsh'].flatMap((tool): (readonly [string, readonly string[]])[] =>
        ['-o=noclobber', '+o=noclobber'].map((flag) => [tool, [flag, 'check.sh', '-c']])),
    ['bash', ['--rcfile=profile', 'check.sh', '-c']],
    ...['-h', '-V'].map((flag): readonly [string, readonly string[]] => ['python', [flag, 'check.py']]),
    ['python', ['-hm', 'suite.cli']], ['python', ['-hW', 'once', 'check.py']],
    ...['-a', '-h', '-i', '-m', '-v', '-?'].map((flag): readonly [string, readonly string[]] => ['php', [flag, 'check.php']]),
    ...['-h', '-v'].map((flag): readonly [string, readonly string[]] => ['perl', [flag, 'check.pl']]),
    ['perl', ['-hMFile::Spec', 'check.pl']],
    ...['powershell', 'pwsh'].flatMap((tool): (readonly [string, readonly string[]])[] =>
        [[tool, ['check.ps1', '-Command']], [tool, ['-File', '-', 'argument']], [tool, ['--', 'check.ps1']]]),
    ['node', ['--', '-', 'argument']],
    ['python', ['-c', 'print(1)']], ['cmd', ['/c', 'code']], ['deno', ['eval', 'code']],
    ['unfamiliar-compiler', ['check.any', '--eval=literal']], ['constructor', ['check.any']], ['__proto__', ['check.any']]
];
for (const [tool, argv] of unresolved) {
    it(`retains unresolved command data for independent inspection: ${tool} ${argv[0]}`, () => {
        const result = parseValidationInterpreterPrefix(tool, Object.freeze([...argv]));
        assert.equal(result.programIndex, argv.length);
        assert.deepEqual(result.options, argv);
    });
}
it('rejects executable Perl module syntax before a source boundary', () => {
    assert.throws(() => parseValidationInterpreterPrefix('perl', ['-MFile::Spec;die', 'check.pl']), /Inline/u);
    assert.throws(() => parseValidationInterpreterPrefix('perl', ['-M', 'File::Spec qw(extra)', 'check.pl']), /Inline/u);
});
it('normalizes numeric control clusters without rewriting the original argv', () => {
    assert.equal(normalizeValidationInterpreterOption('ruby', '-0777e'), '-ve');
    assert.equal(normalizeValidationInterpreterOption('ruby', '-W2e'), '-ve');
    assert.equal(normalizeValidationInterpreterOption('perl', '-0x1EpE'), '-0pE');
    for (const tool of ['ruby', 'perl']) assert.match(normalizeValidationInterpreterOption(tool, `-${'0'.repeat(8192)}e`), /e$/u);
});
it('retains clustered option switches for subsequent rejection checks', () => {
    for (const [tool, argv] of [['ruby', ['-r', 'bundler/setup', 'check.rb']], ['ruby', ['-wrbundler/setup', 'check.rb']],
        ['perl', ['-MFile::Spec', 'check.pl']], ['ruby', ['-I', 'directory', 'check.rb']]] as const) {
        assert.deepEqual(parseValidationInterpreterPrefix(tool, argv).options, [argv[0]]);
    }
});
it('retains incomplete declarations without inventing literal operand indices', () => {
    for (const [tool, flag] of [['node', '--conditions'], ['node', '--require'], ['python', '-W'],
        ['bash', '-o'], ['ruby', '-I'], ['perl', '-I'], ['perl', '-M'], ['perl', '-m'],
        ['python', '-m'], ['pwsh', '-File'], ['powershell', '-File']]) {
        assert.deepEqual(parseValidationInterpreterPrefix(tool, [flag]), { options: [flag], programIndex: 1, literalValueIndices: [] });
    }
});
