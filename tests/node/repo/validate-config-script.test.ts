import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

function makeFallbackFixture(): { root: string; scriptPath: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda config fallback '));
    const scriptsDir = path.join(root, 'scripts');
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(scriptsDir);
    fs.mkdirSync(binDir);
    const scriptPath = path.join(scriptsDir, 'validate-config.cjs');
    fs.copyFileSync(path.join(getRepoRoot(), 'scripts', 'validate-config.cjs'), scriptPath);
    fs.writeFileSync(path.join(binDir, 'garda.js'), [
        "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));",
        "if (process.env.FAKE_VALIDATOR_ERROR) process.stderr.write('validator stderr');",
        "if (process.env.FAKE_VALIDATOR_ERROR) process.exitCode = 7;"
    ].join('\n'));
    return { root, scriptPath };
}

test('config validation fallback passes shell metacharacters as a literal bundle argument', () => {
    const { root, scriptPath } = makeFallbackFixture();
    try {
        const bundleRoot = path.join(root, "space \"double\" 'single' $dollar $(echo expanded) `echo expanded` %CD% & | ;");
        const result = spawnSync(process.execPath, [scriptPath, '--bundle-root', bundleRoot], {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            args: ['gate', 'validate-config', '--bundle-root', bundleRoot, '--compact'],
            cwd: root
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('config validation fallback preserves validator failure output and uses existing bundle cwd', () => {
    const { root, scriptPath } = makeFallbackFixture();
    try {
        const bundleRoot = path.join(root, 'existing bundle');
        fs.mkdirSync(bundleRoot);
        const result = spawnSync(process.execPath, [scriptPath, '--bundle-root', bundleRoot], {
            cwd: root,
            env: { ...process.env, FAKE_VALIDATOR_ERROR: '1' },
            encoding: 'utf8',
            timeout: 30_000
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /validator stderr/u);
        assert.deepEqual(JSON.parse(result.stdout), {
            args: ['gate', 'validate-config', '--bundle-root', bundleRoot, '--compact'],
            cwd: bundleRoot
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
