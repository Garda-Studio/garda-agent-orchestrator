import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { DEPLOY_ITEMS } from '../../src/cli/commands/cli-constants';
import { createBundleSourceFixture } from './bundle-source-fixtures';

function writeFile(root: string, relativePath: string, content: string): void {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
}

function createTrackedSource(context: TestContext): string {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-tracked-source-fixture-'));
    context.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
    for (const entry of DEPLOY_ITEMS) {
        const relativePath = entry === 'bin' ? 'bin/garda.js' : entry === 'template' ? 'template/AGENTS.md' : entry;
        const content = entry === 'VERSION' ? '1.0.0\n'
            : entry === '.gitattributes' ? '* text eol=lf\n'
                : entry === 'package.json' ? '{"name":"garda-agent-orchestrator","version":"1.0.0"}\n'
                    : `tracked ${entry}\n`;
        writeFile(sourceRoot, relativePath, content);
    }
    writeFile(sourceRoot, 'src/bin/garda.ts', 'export const fixture = true;\n');
    childProcess.execFileSync('git', ['init', '--quiet'], { cwd: sourceRoot, windowsHide: true, timeout: 30_000 });
    childProcess.execFileSync('git', ['add', '--', ...DEPLOY_ITEMS, 'src/bin/garda.ts'], {
        cwd: sourceRoot, windowsHide: true, timeout: 30_000
    });
    return sourceRoot;
}

test('bundle source fixtures require no generated cache and exclude untracked or nested deployment state', (context) => {
    const sourceRoot = createTrackedSource(context);
    const cleanFixture = createBundleSourceFixture(context, sourceRoot);
    writeFile(sourceRoot, 'garda-agent-orchestrator/VERSION', 'nested poison');
    writeFile(sourceRoot, 'dist/src/index.js', 'runtime poison');
    writeFile(sourceRoot, 'template/untracked.md', 'template poison');
    const poisonedFixture = createBundleSourceFixture(context, sourceRoot);
    for (const fixture of [cleanFixture, poisonedFixture]) {
        assert.equal(fs.readFileSync(path.join(fixture, 'VERSION'), 'utf8'), '1.0.0\n');
        assert.equal(fs.existsSync(path.join(fixture, 'garda-agent-orchestrator')), false);
        assert.equal(fs.existsSync(path.join(fixture, 'template/untracked.md')), false);
        assert.equal(fs.readFileSync(path.join(fixture, 'dist/src/index.js'), 'utf8'), 'module.exports = {};\n');
    }
});

test('parallel bundle fixtures own their files and cleanup cannot remove another fixture', async (context) => {
    const sourceRoot = createTrackedSource(context);
    const fixtures = await Promise.all(['first', 'second'].map(async (name) => {
        const fixture = createBundleSourceFixture(context, sourceRoot);
        await setImmediate();
        writeFile(fixture, 'VERSION', name);
        return fixture;
    }));
    assert.notEqual(fixtures[0], fixtures[1]);
    assert.equal(fs.readFileSync(path.join(fixtures[0], 'VERSION'), 'utf8'), 'first');
    assert.equal(fs.readFileSync(path.join(fixtures[1], 'VERSION'), 'utf8'), 'second');
    fs.rmSync(fixtures[0], { recursive: true, force: true });
    assert.equal(fs.readFileSync(path.join(fixtures[1], 'VERSION'), 'utf8'), 'second');
    assert.equal(fs.readFileSync(path.join(sourceRoot, 'VERSION'), 'utf8'), '1.0.0\n');
});

test('bundle fixtures fail clearly when a required tracked source asset is missing', (context) => {
    const sourceRoot = createTrackedSource(context);
    childProcess.execFileSync('git', ['rm', '--cached', '--quiet', 'VERSION'], {
        cwd: sourceRoot, windowsHide: true, timeout: 30_000
    });
    assert.throws(() => createBundleSourceFixture(context, sourceRoot), /Tracked bundle fixture input is missing: VERSION/u);
});

test('bundle fixtures reject a missing tracked source entrypoint even when a tracked launcher exists', (context) => {
    const sourceRoot = createTrackedSource(context);
    childProcess.execFileSync('git', ['rm', '--cached', '--quiet', 'src/bin/garda.ts'], {
        cwd: sourceRoot, windowsHide: true, timeout: 30_000
    });
    assert.throws(() => createBundleSourceFixture(context, sourceRoot), /Tracked bundle fixture input is missing: src\/bin\/garda\.ts/u);
});
