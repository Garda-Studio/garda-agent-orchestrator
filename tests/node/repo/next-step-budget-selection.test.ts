import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getRepoRoot, type BuildResult } from '../../../scripts/node-foundation/build';
import { resolveSelectedTestFiles } from '../../../scripts/node-foundation/test';
import { resolveCoverageTestArgs } from '../../../scripts/node-foundation/coverage';
import { parseCommandChain } from '../../../src/core/command-line';

const guard = 'tests/node/gates/next-step/next-step-authenticated-measurement.test.js';
function assertBudgetSelected(root: string): void {
    const scripts = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
    }).scripts;
    const buildRoot = path.resolve(__dirname, '../../..');
    const build: BuildResult = { repoRoot: root, buildRoot, copiedFiles: [], generatedCliPath: '', manifestPath: '' };
    const expected = path.join(buildRoot, guard);
    assert.ok(fs.existsSync(expected), 'The real compiled Q1 guard must exist');
    const commands = parseCommandChain(scripts.test);
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].slice(0, 3), ['node', 'scripts/node-foundation/build-scripts.cjs', 'test.js']);
    const targets = commands[0].slice(3);
    assert.ok(targets.every(value => !value.startsWith('-')), 'Default selection must not filter out individual Q1 tests');
    assert.ok(resolveSelectedTestFiles(build, [expected], targets).includes(expected), 'Default npm test must select Q1');
    const runs = (script: string, dependency: string) => parseCommandChain(scripts[script]).some(command =>
        command.length === 3 && command[0] === 'npm' && command[1] === 'run' && command[2] === dependency);
    assert.ok(runs('validate:release', 'quality'), 'Release must execute quality');
    assert.ok(runs('quality', 'coverage'), 'Release quality must execute coverage');
    assert.deepEqual(parseCommandChain(scripts.coverage), [['node', 'scripts/node-foundation/build-scripts.cjs', 'coverage.js', 'test']]);
    const releaseTargets = resolveCoverageTestArgs(root, 'test', []).slice(2);
    assert.ok(resolveSelectedTestFiles(build, [expected], releaseTargets).includes(expected), 'Release coverage must select Q1');
}

test('Q1 real history regression remains in default test and release validation selections', () => {
    assertBudgetSelected(getRepoRoot());
});

test('Q1 selection guard fails when navigation tests or the release coverage edge are removed', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q1-selection-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const original = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const change of [
        (scripts: Record<string, string>) => { scripts.test = scripts.test.replace(' tests/node/gates ', ' '); },
        (scripts: Record<string, string>) => { scripts.quality = scripts.quality.replace(' && npm run coverage', ''); }
    ]) {
        const scripts = { ...original.scripts }; change(scripts);
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...original, scripts }));
        assert.throws(() => assertBudgetSelected(root), /Default npm test must select Q1|Release quality must execute coverage/);
    }
});
