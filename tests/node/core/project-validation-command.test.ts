import { it } from 'node:test';
import assert from 'node:assert/strict';
import { rejectInlineValidationProgram } from '../../../src/core/project-validation-command';

type Command = readonly [string, readonly string[]];
const shellPrefixes = [[], ['+e'], ['-o', 'errexit'], ['+o', 'errexit'], ['-O', 'extglob'],
    ['+O', 'extglob'], ['--rcfile', 'scripts/rc.sh'], ['--init-file', 'scripts/rc.sh'],
    ['-eo', 'errexit'], ['-onoclobber']];
const shellPrefixesFor = (tool: string) => shellPrefixes.filter((flags) =>
    flags[0] === '-onoclobber' ? tool === 'zsh' : tool === 'bash' || !flags.length || ['+e', '-o', '+o', '-eo'].includes(flags[0]));
const inlinePrograms: Command[] = [
    ['C:\\tools\\node.exe', ['--eval=code']], ['/usr/bin/node', ['-e', 'code']],
    ['node', ['--eval=code']], ['nodejs', ['-p', 'code']], ['node.exe', ['-eprint(1)']],
    ...['-pcode', '-pecode', '--print', '--print=code'].flatMap((flag): Command[] => [['node', [flag, 'code']], ['bun', [flag, 'code']]]),
    ['node', ['--require', 'scripts/bootstrap.js', '--eval=code']],
    ['node', ['--unknown-option', 'value', '--eval=code']],
    ...['bash', 'sh'].flatMap((tool): Command[] => [[tool, ['-oc', 'noclobber', 'code']],
        [tool, ['-onoclobber', 'scripts/check.sh', '-c', 'literal']]]),
    ['node', ['--conditions', '--eval=literal', '--unknown-option', 'value', '--eval=code']],
    ['node', ['--import', 'data:text/javascript,code', '--unknown-option', 'value']],
    ['python3', ['-c', 'code']], ['python3.12', ['-I', '-cprint(1)']],
    ['python3', ['-W', 'ignore', '-c', 'code']], ['python3', ['-Wonce', '-c', 'code']],
    ['python3', ['-Xtracemalloc', '-c', 'code']],
    ['python3', ['-Xsetting=javascript:debug', '-c', 'code']],
    ['python3', ['-X', '-c', '--unknown-option', 'value', '-c', 'code']],
    ...['-IX', '-IW'].map((flag): Command => ['python3', [flag, '-c', '-c', 'code']]),
    ...['bash', 'sh', 'zsh'].flatMap((tool) => shellPrefixes.map((flags): Command =>
        [tool, [...flags, '-c', 'printf injected']])),
    ['powershell.exe', ['-NoProfile', 'Write-Output injected']],
    ['powershell.exe', ['-NoProfile', 'Write-Output injected #', '-File', 'ignored']],
    ['pwsh', ['-File', '-']], ['powershell.exe', ['-File', '-']], ['pwsh', ['-']],
    ...[['-NoProfile'], ['-NoLogo', '-NoProfile'], [' -nop ', '', '/NoLogo'], ['-NonInteractive', '-STA', '-MTA']].map((flags): Command =>
        ['pwsh', [...flags, '-']]),
    ...[['-NoExit'], ['-Noe'], ['/NoExit'], ['-ExecutionPolicy', 'Bypass'], ['--unresolved-option', 'value']].map((flags): Command =>
        ['pwsh', [...flags, '-']]),
    ...[' -Command ', ' -File ', ' -f '].map((flag): Command => ['pwsh', [flag, '-']]),
    ['pwsh', [' ', '-Command', 'code']], ['pwsh', ['-NoProfile', '', ' -Command ', 'code']],
    ...['\u0085', '\u00a0', '\u2028', '\u3000'].flatMap((space): Command[] =>
        [['pwsh', [space, `${space}-Command${space}`, 'code']], ['pwsh', ['-NoProfile', `${space}-File${space}`, '-']]]),
    ...['-f', '-fi', '-fil', '-F', '--f', '/File', '\u2013f', '\u2014File', '\u2015\u2015f'].map((flag): Command => ['pwsh', [flag, '-']]),
    ...['pwsh', 'powershell.exe'].flatMap((tool) =>
        ['-Command', '-CommandWithArgs', '-cwa', '-COMMANDWITHARGS', '-EncodedCommand', '-EncodedArguments', '-c', '-enco', '-ec', '-ea', '--Command', '/ec', '\u2013Command', '\u2014\u2014ec'].map((flag): Command =>
            [tool, ['-NoProfile', flag, 'code']])),
    ...['-r', '--run', '-B', '--process-begin', '-R', '--process-code', '-E', '--process-end'].map((flag): Command => ['php', [flag, 'echo 1;']]),
    ...['-nr', '-nB', '-nR', '-nE', '-CnHr'].map((flag): Command => ['php', [flag, 'echo 1;']]),
    ['ruby', ['-we', 'code']], ['ruby', ['-w', '-e', 'code']],
    ...['-0777e', '-0e', '-W2e', '-KUe', '-d0777we', '-w0ne'].map((flag): Command => ['ruby', [flag, 'puts 1']]),
    ...['-ne', '-0777pe', '-0777pE', '-0x1EpE'].map((flag): Command => ['perl', [flag, 'print 1']]),
    ['perl', ['-w', '-e', 'print 1']], ['cmd', ['/c', 'code']], ['cmd.exe', ['/K', 'code']],
    ['perl', ['-MFile::Spec;die', 'scripts/check.pl']], ['perl', ['-M', 'File::Spec qw(extra)', 'scripts/check.pl']],
    ['perl', ['-Itest', '-e', 'print 1']], ['perl', ['-MFile::Spec', '-e', 'print 1']],
    ['deno', ['eval', 'code']], ['deno', ['run', '--unknown', 'value', 'javascript:code']],
    ['bun', ['--eval=code']], ['bun', ['repl', '-e', 'code']], ['bun', ['run', '--print', 'code']], ['node', ['data:text/javascript,code']],
    ['node', ['--loader=javascript:code', 'scripts/check.js']],
    ['node', ['--import', 'data:text/javascript,code', 'scripts/check.js']],
    ['node', ['--import=javascript:code', 'scripts/check.js']],
    ['node', ['\u0000java\nscript:code']], ['node', ['--import=\tdata:text/javascript,code', 'scripts/check.js']]
];
for (const [tool, argv] of inlinePrograms) {
    it(`rejects inline invocation ${tool} ${argv.join(' ')}`, () => {
        assert.throws(() => rejectInlineValidationProgram(tool, argv), /Inline|Shell wrappers/u);
    });
}

const literalCommands: Command[] = [
    ['check.cmd', []], ['check.BAT', []], ['proof-driver', ['--scenario', 'javascript:literal']],
    ['C:\\tools\\node.exe', ['scripts/check.js', '--eval=literal']],
    ['/usr/bin/node', ['scripts/check.js', '--eval=literal']],
    ['node', ['scripts/check.js', '--eval=literal']],
    ...['--print-bytecode', '--print-code', '--print-bytecode-filter=check', '--eval-diagnostic'].map((flag): Command => ['node', [flag, 'scripts/check.js']]),
    ...['node', 'python3', 'ruby', 'perl'].flatMap((tool): Command[] =>
        [['scripts/check=javascript:literal', '--eval=literal'], ['scripts/check=data:literal']].map((argv) => [tool, argv])),
    ['node', ['--require', 'scripts/bootstrap.js', 'scripts/check.js', '--eval=literal']],
    ['node', ['--import', 'scripts/bootstrap.js', 'scripts/check.js', 'javascript:literal']],
    ['node', ['--conditions', 'eval', 'scripts/check.js', '--print=literal']],
    ['node', ['--conditions', 'javascript:debug', 'scripts/check.js']],
    ['node', ['--conditions=javascript:debug', 'scripts/check.js']],
    ['node', ['-C', 'data:literal', 'scripts/check.js']],
    ['node', ['--conditions', '--eval=literal', '--unknown-option', 'value']],
    ['node', ['-C', '--print=literal', '--unknown-option', 'value']],
    ['python3', ['-X', '-c', '--unknown-option', 'value']],
    ...['-IX', '-IW'].map((flag): Command => ['python3', [flag, '-c', 'scripts/check.py', '-c', 'javascript:literal']]),
    ['python3', ['-X', 'javascript:debug', 'scripts/check.py']],
    ['python3', ['-X', 'setting=javascript:debug', 'scripts/check.py']],
    ...['-Xsetting=javascript:debug', '-IXsetting=javascript:debug', '-Wignore:arg=javascript:debug:UserWarning'].map((flag): Command =>
        ['python3', [flag, 'scripts/check.py']]),
    ['python3', ['scripts/check.py', '-c', 'literal']],
    ['python3', ['-I', '-m', 'suite.cli', '-c', 'literal']],
    ['python3', ['-mpackage.m', 'javascript:literal']],
    ['python3', ['-Wonce', 'scripts/check.py']], ['python3', ['-Xtracemalloc', 'scripts/check.py']],
    ['python3', ['-W', 'ignore', 'scripts/check.py', '-c', 'literal']],
    ['perl', ['-0x1E', 'scripts/check.pl']],
    ...['-Itest', '-MFile::Spec', '-mFile::Spec', '-Mlib=left,right', '-wItest', '-Ftext', '-i.bak', '-l012'].map((flag): Command =>
        ['perl', [flag, 'scripts/check.pl', '-e', 'javascript:literal']]),
    ['perl', ['-I', 'javascript:literal', 'scripts/check.pl', '-e', 'literal']],
    ['perl', ['-M', 'File::Spec', 'scripts/check.pl', '-e', 'literal']],
    ...['-0', '-0777', '-0x1E'].map((flag): Command =>
        ['perl', [flag, 'scripts/check.pl', '-e', 'javascript:literal']]),
    ...['-w', '-nw', '-pw'].map((flag): Command => ['perl', [flag, 'scripts/check.pl', '-e', 'literal']]),
    ...['-Command', '-CommandWithArgs', '-cwa'].map((flag): Command =>
        ['pwsh', ['-NoProfile', '-File', 'scripts/check.ps1', flag, 'literal']]),
    ['powershell.exe', ['-File', 'scripts/check.ps1', '-Command', 'literal']],
    ...['pwsh', 'powershell.exe'].flatMap((tool): Command[] => [
        [tool, ['-File', ' ', '-', '-Command', 'javascript:literal']], [tool, ['-File', '\u3000', '-EncodedCommand', 'literal']]]),
    ...['-f', '-fi', '-FIL', '--f', '/File', '\u2013f'].map((flag): Command => ['pwsh', ['-NoProfile', flag, 'scripts/check.ps1', '-ec', 'literal']]),
    ['pwsh', ['/scripts/check.ps1', '-ea', 'literal']],
    ...['\uFEFF', '\u200B'].map((literal): Command =>
        ['pwsh', [`${literal}-Command`, '-ec', 'literal']]),
    ...['-NoProfile', '-nop', '/NoProfile', ' -NoProfile '].map((flag): Command => ['pwsh', [flag, 'scripts/check.ps1', '-Command', 'javascript:literal']]),
    ['pwsh', ['-NoLogo', '-NoProfile', '', 'scripts/check.ps1', ' ', '-ec', 'literal']],
    ['pwsh', ['scripts/check.ps1', '-cwa', 'literal']],
    ['pwsh', ['scripts/check.ps1', '-File', '-', 'javascript:literal']],
    ['ruby', ['-w', 'scripts/check.rb', '-e', 'literal']], ['bun', ['./repl', '-e', 'literal']],
    ...['-0777', '-W2', '-Ke', '-d0777w'].map((flag): Command => ['ruby', [flag, 'scripts/check.rb', '-e', 'literal']]),
    ['ruby', ['-rbundler/setup', 'scripts/check.rb']],
    ...['-n', '-CneH'].map((flag): Command => ['php', [flag, 'scripts/check.php', '-r', 'literal']]),
    ['deno', ['run', 'scripts/check.ts', 'eval']], ...['scripts/check.ts', 'repl'].map((file): Command => ['bun', ['run', file, '-p', 'literal']]),
    ...['bash', 'sh', 'zsh'].flatMap((tool) => shellPrefixesFor(tool).map((flags): Command =>
        [tool, [...flags, 'scripts/check.sh', '-c', 'literal']]))
];
for (const [tool, argv] of literalCommands) {
    it(`preserves literal invocation ${tool} ${argv.join(' ')}`, () => {
        const before = [...argv];
        assert.doesNotThrow(() => rejectInlineValidationProgram(tool, argv));
        assert.deepEqual(argv, before);
    });
}

it('rejects long numeric option clusters without nested repeated matches', () => {
    for (const tool of ['ruby', 'perl']) assert.throws(() => rejectInlineValidationProgram(tool, [`-${'0'.repeat(8192)}e`, 'code']), /Inline/u);
});

for (const tool of ['unfamiliar-compiler', 'constructor', '__proto__', 'toString']) {
    it(`keeps ${tool} as an unapproved declaration without inherited adapter properties`, () => {
        assert.equal(rejectInlineValidationProgram(tool, ['--pattern', '*.any', '--eval=literal']), undefined);
    });
}
