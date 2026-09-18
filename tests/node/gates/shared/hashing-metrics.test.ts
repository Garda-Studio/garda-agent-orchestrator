import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendMetricsEvent, countFileLines } from '../../../../src/gates/shared/hashing-metrics';

test('countFileLines excludes binary and invalid UTF-8 while retaining Unicode text counts', (context) => {
    const tmpDir = makeTmpDir();
    context.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const inputPath = path.join(tmpDir, 'input');
    for (const bytes of [Buffer.from('binary\0payload\nline\n'), Buffer.from([0xff, 0x0a, 0x61])]) {
        fs.writeFileSync(inputPath, bytes);
        assert.equal(countFileLines(inputPath), 0);
    }
    fs.writeFileSync(inputPath, 'первая\r\n\n  \n二行\n', 'utf8');
    assert.equal(countFileLines(inputPath), 2);
});

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-hashing-metrics-test-'));
}

function seedBundleRoot(bundleRoot: string): void {
    fs.writeFileSync(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
    fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '', 'utf8');
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
}

test('appendMetricsEvent samples toxin snapshots instead of scanning on every event', () => {
    const tmpDir = makeTmpDir();
    try {
        seedBundleRoot(tmpDir);
        const metricsPath = path.join(tmpDir, 'runtime', 'metrics.jsonl');

        appendMetricsEvent(metricsPath, { gate: 'first' }, true, tmpDir);
        appendMetricsEvent(metricsPath, { gate: 'second' }, true, tmpDir);

        const lines = fs.readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean);
        const parsed = lines.map(line => JSON.parse(line) as Record<string, unknown>);

        assert.equal(parsed.filter(entry => entry.gate === 'first').length, 1);
        assert.equal(parsed.filter(entry => entry.gate === 'second').length, 1);
        assert.equal(parsed.filter(entry => entry.metric_type === 'disk_artifact_growth').length, 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('appendMetricsEvent low-noise mode skips metrics and toxin snapshot writes', () => {
    const tmpDir = makeTmpDir();
    const previousEnv = process.env.GARDA_LOW_NOISE_RUNTIME_WRITES;
    try {
        seedBundleRoot(tmpDir);
        const metricsPath = path.join(tmpDir, 'runtime', 'metrics.jsonl');

        process.env.GARDA_LOW_NOISE_RUNTIME_WRITES = '1';
        appendMetricsEvent(metricsPath, { gate: 'low-noise' }, true, tmpDir);

        assert.equal(fs.existsSync(metricsPath), false);
        assert.equal(fs.existsSync(`${metricsPath}.toxin-snapshot-state.json`), false);
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_LOW_NOISE_RUNTIME_WRITES;
        } else {
            process.env.GARDA_LOW_NOISE_RUNTIME_WRITES = previousEnv;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
