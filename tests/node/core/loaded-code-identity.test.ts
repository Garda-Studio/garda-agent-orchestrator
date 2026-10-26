import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const driver = require.resolve('./loaded-code-identity-driver');
const bootstrap = require.resolve('../../../src/bin/garda/derivation-source-receipts');
function child(scenario: string, root?: string, preload = true) {
    const args = [...(preload ? ['-r', bootstrap] : []), driver, scenario, ...(root ? [root] : [])];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, scenario + ': ' + result.stdout + result.stderr);
}
for (const scenario of ['loaded-json-replaced', 'native-json-error', 'loaded-dependency-replaced', 'final-source-replaced', 'module-instance-replaced', 'same-byte-file-replaced',
    'real-reducer-replaced', 'real-renderer-replaced']) {
    test('shared loaded code authority: ' + scenario, { timeout: 130000 }, () => child(scenario));
}
for (const scenario of ['no-bootstrap', 'late-bootstrap', 'custom-loader']) {
    test('shared code authority retains native startup without invented receipts: ' + scenario,
        { timeout: 130000 }, () => child(scenario, undefined, false));
}
test('shared code authority accepts an authenticated binding in a genuinely cold process', { timeout: 250000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-code-cold-'));
    try { child('seed', root); child('cold-hit', root); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
});
