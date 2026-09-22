import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

test('next-step benchmark validates inputs and reports stable process timings', (context) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-benchmark-'));
    context.after(() => {
        const tempRoot = path.resolve(os.tmpdir());
        assert.ok(path.resolve(fixtureRoot).startsWith(`${tempRoot}${path.sep}`));
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });

    const scriptsDir = path.join(fixtureRoot, 'scripts');
    const binDir = path.join(fixtureRoot, 'bin');
    fs.mkdirSync(scriptsDir);
    fs.mkdirSync(binDir);
    const benchmarkPath = path.join(scriptsDir, 'benchmark-next-step.cjs');
    fs.copyFileSync(path.join(getRepoRoot(), 'scripts', 'benchmark-next-step.cjs'), benchmarkPath);
    fs.writeFileSync(path.join(binDir, 'garda.js'), [
        "'use strict';",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const counterPath = path.join(__dirname, '..', 'counter.txt');",
        "const count = (Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : 0) + 1);",
        "fs.writeFileSync(counterPath, String(count));",
        "if (process.env.BENCHMARK_FAIL_CHILD === '1' && count === 2) {",
        "    process.stderr.write('synthetic next-step failure\\n');",
        "    process.exit(7);",
        "}",
        "const next_gate = process.env.BENCHMARK_CHANGE_OUTPUT === '1' && count === 2 ? 'changed' : 'stable';",
        "process.stdout.write(JSON.stringify({ generated_utc: String(count), next_gate, marker: 'same' }));"
    ].join('\n'));

    const run = (sampleCount: string, changeOutput = false, failChild = false) => spawnSync(
        process.execPath,
        [benchmarkPath, 'T-BENCH', fixtureRoot, sampleCount],
        {
            cwd: fixtureRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                BENCHMARK_CHANGE_OUTPUT: changeOutput ? '1' : '0',
                BENCHMARK_FAIL_CHILD: failChild ? '1' : '0'
            }
        }
    );
    const counterPath = path.join(fixtureRoot, 'counter.txt');

    const invalid = run('1000');
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /sample-count=6\.\.30/u);
    assert.equal(fs.existsSync(counterPath), false);

    const valid = run('6');
    assert.equal(valid.status, 0, valid.stderr);
    const report = JSON.parse(valid.stdout) as {
        process_count: number;
        subsequent_ms: number[];
        subsequent_median_ms: number;
        subsequent_range_ms: number[];
        output_equivalent: boolean;
        normalized_output_sha256: string;
    };
    assert.equal(report.process_count, 6);
    assert.equal(report.subsequent_ms.length, 5);
    const sorted = [...report.subsequent_ms].sort((left, right) => left - right);
    assert.equal(report.subsequent_median_ms, sorted[2]);
    assert.deepEqual(report.subsequent_range_ms, [sorted[0], sorted[4]]);
    assert.equal(report.output_equivalent, true);
    assert.equal(report.normalized_output_sha256, createHash('sha256')
        .update(JSON.stringify({ next_gate: 'stable', marker: 'same' })).digest('hex'));
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '6');

    fs.writeFileSync(counterPath, '0');
    const changed = run('6', true);
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /output changed between samples 1 and 2/u);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');

    fs.writeFileSync(counterPath, '0');
    const failed = run('6', false, true);
    assert.equal(failed.status, 7);
    assert.match(failed.stderr, /synthetic next-step failure/u);
    assert.equal(failed.stdout, '');
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
});

test('next-step benchmark accepts the real CLI output contract', { timeout: 30_000 }, () => {
    const repoRoot = getRepoRoot();
    const run = spawnSync(process.execPath, [
        path.join(repoRoot, 'scripts', 'benchmark-next-step.cjs'),
        'T-BENCH-UNDECLARED', repoRoot, '6'
    ], { cwd: repoRoot, encoding: 'utf8', timeout: 25_000 });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout) as {
        task_id: string;
        route: string;
        process_count: number;
        subsequent_ms: number[];
        output_equivalent: boolean;
    };
    assert.equal(report.task_id, 'T-BENCH-UNDECLARED');
    assert.equal(report.route, 'enter-task-mode');
    assert.equal(report.process_count, 6);
    assert.equal(report.subsequent_ms.length, 5);
    assert.equal(report.output_equivalent, true);
});
