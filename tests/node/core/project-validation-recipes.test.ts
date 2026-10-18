import { it } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleExpectedRedRecipes, parseProjectValidationContract } from '../../../src/core/project-validation-recipes';

function declaration(overrides: Record<string, unknown> = {}) {
    return { schema_version: 1, recipes: [{ id: 'controle', purpose: 'test', executable: 'unfamiliar-compiler',
        argv: ['--pattern', '*.x', { target: '識別子' }], cwd: '.',
        inputs: [{ path: 'product.any', role: 'source' }, { path: 'specifications/case.unfamiliar', role: 'test' }],
        targets: [{ id: '識別子', source: 'specifications/case.unfamiliar', selector: 'проверка' }], environment: {},
        timeout_ms: 5000, max_attempts: 3, max_output_bytes: 65536, max_input_bytes: 65536,
        required_capabilities: [], result_format: 'tap', ...overrides }] };
}

for (const executable of ['unfamiliar-compiler', 'constructor', '__proto__', 'toString']) it(`binds ${executable}, unfamiliar layouts and Unicode selectors as literal data`, () => {
    const recipe = parseProjectValidationContract(declaration({ executable })).recipes[0];
    assert.equal(recipe.executable, executable);
    assert.deepEqual(recipe.argv, declaration().recipes[0].argv);
    assert.equal(recipe.targets[0].selector, 'проверка');
    assert.equal(recipe.inputs[1].path, 'specifications/case.unfamiliar');
    assert.equal('approved' in recipe, false);
});

const invalidRecipes: Array<[string, Record<string, unknown>, RegExp]> = [
    ['foreign target reference', { argv: [{ target: 'foreign' }] }, /Unknown argument target/u],
    ['escaping working directory', { cwd: '../outside' }, /canonical/u],
    ['escaping input', { inputs: [{ path: '../source', role: 'source' }] }, /canonical/u],
    ['undeclared test target', { targets: [{ id: 'other', source: 'absent.any', selector: 'x' }] }, /declared test input/u],
    ['empty test targets', { targets: [] }, /exact targets/u],
    ['unknown input role', { inputs: [{ path: 'file', role: 'approval' }] }, /Unknown input role/u],
    ['NUL argument', { argv: ['a\0b'] }, /NUL/u],
    ['null environment', { environment: null }, /expected object/u],
    ['array environment', { environment: [] }, /expected object/u],
    ...[['NODE_OPTIONS', '--eval=unsafe'], ['RUBYOPT', '-r./scripts/bootstrap.rb'], ['PERL5OPT', '-Mbootstrap'], ['LD_AUDIT', '/tmp/audit.so'], ['PYTHONPATH', 'undeclared/startup-modules'], ['ZDOTDIR', 'undeclared/startup'], ['HOME', 'undeclared/startup']].map(([key, value]) => [`implicit injection environment ${key}`, { environment: { [key]: value } }, /injection/u] as [string, Record<string, unknown>, RegExp]),
    ['case-aliased environment keys', { environment: { token: 'a', TOKEN: 'b' } }, /duplicate/u],
    ['unknown enforced capability', { required_capabilities: ['sandboxed'] }, /Unknown enforced capability/u],
    ['zero attempt budget', { max_attempts: 0 }, /out of bounds/u],
    ['unsafe timeout', { timeout_ms: Number.MAX_SAFE_INTEGER }, /out of bounds/u]
];
for (const [name, overrides, expected] of invalidRecipes) {
    it(`rejects ${name} before a declaration can become authority`, () => assert.throws(() => parseProjectValidationContract(declaration(overrides)), expected));
}

it('rejects self-approval, unsupported schemas, sparse arrays, duplicate identities and oversized declarations', () => {
    assert.throws(() => parseProjectValidationContract({ ...declaration(), approved: true }), /unknown property/u);
    assert.throws(() => parseProjectValidationContract({ ...declaration(), schema_version: 2 }), /version/u);
    assert.throws(() => parseProjectValidationContract({ schema_version: 1, recipes: [] }), /at least one recipe/u);
    assert.throws(() => parseProjectValidationContract({ schema_version: 1, recipes: Array(1) }), /expected object/u);
    assert.throws(() => parseProjectValidationContract({ schema_version: 1, recipes: Array(2).fill(declaration().recipes[0]) }), /duplicate/u);
    assert.throws(() => parseProjectValidationContract(declaration({ environment: { VALUE: 'x'.repeat(1_048_576) } })), /byte bound/u);
});

it('validates literal environments without repeated scans of their own key list', () => {
    const count = 512;
    const environment = Object.fromEntries(Array.from({ length: count }, (_, index) => [`ENTRY_${index}`, 'literal']));
    const includes = Array.prototype.includes;
    let scannedKeys = 0;
    Array.prototype.includes = function (this: unknown[], value: unknown, fromIndex?: number): boolean {
        if (this.length === count && this[0] === 'ENTRY_0') scannedKeys += this.length;
        return includes.call(this, value, fromIndex);
    };
    try { assert.deepEqual({ ...parseProjectValidationContract(declaration({ environment })).recipes[0].environment }, environment); }
    finally { Array.prototype.includes = includes; }
    assert.ok(scannedKeys <= count * 2, `Repeated environment key scans: ${scannedKeys}`);
});

it('rejects oversized recipe arrays before whole-input serialization', () => {
    const input = { schema_version: 1, recipes: Array(65) }, stringify = JSON.stringify;
    let wholeSerializations = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { if (args[0] === input) wholeSerializations++; return Reflect.apply(stringify, JSON, args); }) as typeof JSON.stringify;
    try { assert.throws(() => parseProjectValidationContract(input), /bounded array/u); }
    finally { JSON.stringify = stringify; }
    assert.equal(wholeSerializations, 0);
});

const shellOptionPrefixes = [['+e'], ['-o', 'errexit'], ['+o', 'errexit'], ['-O', 'extglob'], ['+O', 'extglob'], ['--rcfile', 'scripts/rc.sh'], ['--init-file', 'scripts/rc.sh'], ['-eo', 'errexit']];
it('preserves inline-program rejection independently of project source extensions', () => {
    for (const [executable, argv] of [['node', ['--eval=code']], ['python3', ['-c', 'code']],
        ...shellOptionPrefixes.map((flags) => ['bash', [...flags, '-c', 'printf injected']] as const), ['powershell.exe', ['-NoProfile', 'Write-Output injected']],
        ...['-r', '--run', '-B', '--process-begin', '-R', '--process-code', '-E', '--process-end'].map((flag) => ['php', [flag, 'echo 1;']] as const),
        ['ruby', ['-we', 'code']], ...['-ne', '-0777pe', '-0777pE', '-0x1EpE'].map((flag) => ['perl', [flag, 'print 1']] as const), ['cmd', ['/c', 'code']]] as const) {
        assert.throws(() => parseProjectValidationContract(declaration({ executable, argv })), /Inline/u);
    }
});

it('preserves literal program arguments after a file or module boundary', () => {
    for (const [executable, argv] of [['node', ['scripts/check.js', '--eval=literal']],
        ['node', ['--require', 'scripts/bootstrap.js', 'scripts/check.js', '--eval=literal']],
        ['python3', ['scripts/check.py', '-c', 'literal']], ['python3', ['-I', '-m', 'suite.cli', '-c', 'literal']],
        ['python3', ['-Wonce', 'scripts/check.py']], ['python3', ['-Xtracemalloc', 'scripts/check.py']], ['perl', ['-0x1E', 'scripts/check.pl']], ...['-w', '-nw', '-pw'].map((flag) => ['perl', [flag, 'scripts/check.pl', '-e', 'literal']]),
        ['node', ['scripts/check.js', 'javascript:literal']], ['python3', ['-mpackage.m', 'javascript:literal']],
        ...['-Command', '-CommandWithArgs', '-cwa'].map((flag) => ['pwsh', ['-NoProfile', '-File', 'scripts/check.ps1', flag, 'literal']]), ['powershell.exe', ['-File', 'scripts/check.ps1', '-Command', 'literal']],
        ['ruby', ['-w', 'scripts/check.rb', '-e', 'literal']], ['deno', ['run', 'scripts/check.ts', 'eval']], ['zsh', ['-onoclobber', 'scripts/check.sh', '-c', 'literal']], ...shellOptionPrefixes.map((flags) => ['bash', [...flags, 'scripts/check.sh', '-c', 'literal']])]) {
        assert.doesNotThrow(() => parseProjectValidationContract(declaration({ executable, argv })), `${executable} ${JSON.stringify(argv)}`);
    }
    for (const [executable, argv] of [['node', ['--require', 'scripts/bootstrap.js', '--eval=code']],
        ['node', ['--unknown-option', 'value', '--eval=code']], ['python3', ['-W', 'ignore', '-c', 'code']],
        ...['-Command', '-CommandWithArgs', '-cwa', '-COMMANDWITHARGS'].map((flag) => ['pwsh', ['-NoProfile', flag, 'code']]), ['ruby', ['-w', '-e', 'code']], ['perl', ['-w', '-e', 'print 1']], ['deno', ['eval', 'code']], ['bash', ['-onoclobber', 'scripts/check.sh', '-c', 'literal']]]) {
        assert.throws(() => parseProjectValidationContract(declaration({ executable, argv })), /Inline/u);
    }
    assert.throws(() => parseProjectValidationContract(declaration({ executable: 'node', argv: ['data:text/javascript,code'] })), /Inline/u);
});

it('uses declared test roles for expected-red eligibility and rejects source-role aliasing', () => {
    const recipe = parseProjectValidationContract(declaration()).recipes[0];
    const other = parseProjectValidationContract({ schema_version: 1, recipes: [{ ...recipe, id: 'other', argv: [{ target: 'second' }], inputs: [{ path: 'second.any', role: 'test' }, { path: 'untargeted.any', role: 'test' }],
        targets: [{ id: 'second', source: 'second.any', selector: 'second' }] }] }).recipes[0];
    assert.deepEqual(eligibleExpectedRedRecipes([recipe, other], ['specifications/case.unfamiliar']), [recipe]);
    assert.throws(() => eligibleExpectedRedRecipes([recipe], ['product.any']), /test-only/u);
    assert.throws(() => eligibleExpectedRedRecipes([recipe], []), /test-only/u);
    const alias = { ...other, inputs: [{ path: 'specifications/case.unfamiliar', role: 'source' as const }] };
    assert.throws(() => eligibleExpectedRedRecipes([recipe, alias], ['specifications/case.unfamiliar']), /test-only/u);
    const opaque = { ...recipe, result_format: 'opaque' as const };
    assert.deepEqual(eligibleExpectedRedRecipes([opaque], ['specifications/case.unfamiliar']), [opaque]);
    for (const candidates of [[recipe, { ...other, result_format: 'opaque' as const }], [other], [parseProjectValidationContract(declaration({ argv: [] })).recipes[0]], [parseProjectValidationContract(declaration({ argv: ['unrelated.any'] })).recipes[0]]]) assert.throws(() => eligibleExpectedRedRecipes(candidates, candidates.flatMap((entry) => entry.inputs.filter((input) => input.role === 'test').map((input) => input.path))), /executed changed declared test target/u);
});

it('rejects case-aliased input identities on Windows', { skip: process.platform !== 'win32' }, () => {
    const inputs = [...declaration().recipes[0].inputs, { path: 'Specifications/case.unfamiliar', role: 'source' }];
    assert.throws(() => parseProjectValidationContract(declaration({ inputs })), /duplicate/u);
});

it('rejects Windows source-role aliases across recipes before expected-red selection', { skip: process.platform !== 'win32' }, () => {
    const recipe = parseProjectValidationContract(declaration()).recipes[0];
    const alias = parseProjectValidationContract(declaration({ id: 'source-alias', argv: [{ target: 'second' }],
        inputs: [{ path: 'Specifications/case.unfamiliar', role: 'source' }, { path: 'second.any', role: 'test' }],
        targets: [{ id: 'second', source: 'second.any', selector: 'second' }] })).recipes[0];
    assert.throws(() => eligibleExpectedRedRecipes([recipe, alias], ['specifications/case.unfamiliar']), /test-only/u);
});

it('rejects trailing-period and trailing-space Windows path aliases', { skip: process.platform !== 'win32' }, () => {
    for (const path of ['specifications/case.unfamiliar.', 'specifications/case.unfamiliar ', 'specifications./case.unfamiliar', 'specifications /case.unfamiliar']) {
        const inputs = [...declaration().recipes[0].inputs, { path, role: 'source' }];
        assert.throws(() => parseProjectValidationContract(declaration({ inputs })), /canonical/u);
    }
});

it('rejects sparse changed-file scopes before expected-red selection', () => {
    const recipe = parseProjectValidationContract(declaration()).recipes[0];
    const changedFiles = Array<unknown>(2);
    changedFiles[0] = 'specifications/case.unfamiliar';
    assert.throws(() => eligibleExpectedRedRecipes([recipe], changedFiles), /test-only/u);
});
