import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

test('gate help does not load execution handler modules', () => {
    const gateModule = path.resolve(__dirname, '../../../src/cli/commands/gate-command.js');
    const run = spawnSync(process.execPath, ['-e', `
        require(process.argv[1]).handleGate(['--help']).then(() => {
            process.stderr.write(JSON.stringify(Object.keys(require.cache).filter(p => /gate-(task|build|review)-handlers\\.js$/.test(p))));
        });
    `, gateModule], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Available gates:/);
    assert.deepEqual(JSON.parse(run.stderr), []);
});

test('launcher enables its external compile cache and honors the native disable switch', () => {
    const launcher = path.resolve(__dirname, '../../../src/bin/garda.js');
    for (const disabled of [false, true]) {
        const env = { ...process.env };
        delete env.NODE_DISABLE_COMPILE_CACHE;
        if (disabled) env.NODE_DISABLE_COMPILE_CACHE = '1';
        const run = spawnSync(process.execPath, ['-e', `
            require(process.argv[1]);
            process.stdout.write(JSON.stringify(require('node:module').getCompileCacheDir() || null));
        `, launcher], { encoding: 'utf8', env });
        assert.equal(run.status, 0, run.stderr);
        const directory = JSON.parse(run.stdout) as string | null;
        if (disabled) assert.equal(directory, null);
        else {
            assert.ok(directory);
            assert.ok(!path.resolve(directory).startsWith(path.resolve(__dirname, '../../..') + path.sep));
        }
    }
});
