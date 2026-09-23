import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const { evaluateWallTimeBaseline } = require(path.join(process.cwd(), 'scripts/node-foundation/check-test-wall-time-baseline.cjs')) as {
    evaluateWallTimeBaseline: (baseline: object, baselineLog: string, candidateLogs: string[]) => {
        baselineMs: number;
        candidateMs: number;
        candidateSamples: number;
        environmentFingerprint: string;
        selectedFiles: number;
        deltaMs: number;
        ratio: number;
    };
};

const environmentFingerprint = 'a'.repeat(64);
const candidateSourceSha256 = 'b'.repeat(64);

function candidateLog(wallMs: number, files = 532, run = 1, sample = run): string {
    const startUtc = new Date(Date.UTC(2026, 8, 23, 0, sample * 2)).toISOString();
    const endUtc = new Date(Date.UTC(2026, 8, 23, 0, sample * 2 + 1)).toISOString();
    return `> garda-agent-orchestrator@1.4.3 quality\n> garda-agent-orchestrator@1.4.3 test\nNODE_FOUNDATION_TEST_SHARD_LOG_DIR C:\\test-shards\\run-${run}\nNODE_FOUNDATION_TEST_SHARD_COMPARISON source=observed_run telemetry_known=500/${files} observed_wall_ms=${wallMs}\nNODE_FOUNDATION_TEST_OK\nNODE_FOUNDATION_QUALITY_ENVIRONMENT schema=2 fingerprint=${environmentFingerprint} source_sha256=${candidateSourceSha256} platform=win32 arch=x64 node=v24.11.1 cpu_count=24 available_parallelism=24 total_memory_bytes=102455558144 cpu_busy_percent=20.0 start_utc=${startUtc} end_utc=${endUtc} exit_code=0 signal=none\n`;
}

const baselineLog = candidateLog(1000, 531, 100, 0);
const baseline = {
    schema_version: 2,
    source_command: 'npm run quality',
    source_log_sha256: crypto.createHash('sha256').update(baselineLog).digest('hex'),
    environment_fingerprint_sha256: environmentFingerprint,
    observed_wall_ms: 1000,
    max_wall_time_ratio: 0.95,
    selected_file_count: 531,
    minimum_known_file_count: 400
};

function compare(candidate: string, secondCandidate = candidateLog(900, 532, 2), sourceBaseline: object = baseline, sourceLog = baselineLog) {
    return evaluateWallTimeBaseline({
        candidate_log_sha256: [candidate, secondCandidate].map((log) => crypto.createHash('sha256').update(log).digest('hex')),
        candidate_source_sha256: candidateSourceSha256,
        ...sourceBaseline
    }, sourceLog, [candidate, secondCandidate]);
}

test('wall-time baseline records a complete before-and-after comparison', () => {
    assert.deepEqual(compare(candidateLog(950)), {
        baselineMs: 1000,
        candidateMs: 950,
        candidateSamples: 2,
        environmentFingerprint,
        selectedFiles: 532,
        deltaMs: -50,
        ratio: 0.95
    });
});

test('wall-time baseline requires speedup and complete selection', () => {
    assert.throws(() => compare(candidateLog(951)), /exceeds the baseline speedup limit/u);
    assert.throws(() => compare(candidateLog(900), candidateLog(900, 532, 2), { ...baseline, max_wall_time_ratio: Infinity }), /Maximum wall-time ratio/u);
    assert.throws(() => compare(candidateLog(900), candidateLog(900, 532, 2), { ...baseline, max_wall_time_ratio: 1 }), /Maximum wall-time ratio/u);
    assert.throws(() => compare(
        candidateLog(900)
            .replace('NODE_FOUNDATION_TEST_SHARD_COMPARISON', 'NODE_FOUNDATION_TEST_OK\nNODE_FOUNDATION_TEST_SHARD_COMPARISON')
            .replace('NODE_FOUNDATION_TEST_OK\nNODE_FOUNDATION_QUALITY_ENVIRONMENT', 'NODE_FOUNDATION_QUALITY_ENVIRONMENT')
    ), /completed full-selection/u);
    assert.throws(() => compare(
        candidateLog(900).replace(/^> garda-agent-orchestrator@1\.4\.3 quality\n/u,
            'NODE_FOUNDATION_TEST_DURATION_TELEMETRY_UPDATE_SKIPPED reason=partial_test_selection option=--test-name-pattern\n')
    ), /completed full-selection/u);
    assert.throws(() => compare(candidateLog(900, 530)), /completed full-selection/u);
    assert.throws(() => compare(candidateLog(900).replace('500/532', '0/602')), /completed full-selection/u);
    assert.throws(() => compare(candidateLog(900).replace('NODE_FOUNDATION_TEST_OK', '')), /completed full-selection/u);
    assert.throws(() => compare(candidateLog(900)
        .replace('NODE_FOUNDATION_TEST_SHARD_LOG_DIR',
            'NODE_FOUNDATION_TEST_DURATION_TELEMETRY_UPDATE_SKIPPED reason=partial_test_selection option=--test-name-pattern\nNODE_FOUNDATION_TEST_SHARD_LOG_DIR')),
    /completed full-selection/u);
    assert.doesNotThrow(() => compare(candidateLog(900)
        .replace('NODE_FOUNDATION_TEST_SHARD_COMPARISON',
            'NODE_FOUNDATION_TEST_DURATION_TELEMETRY_UPDATE_SKIPPED reason=partial_test_selection option=--test-name-pattern\nNODE_FOUNDATION_TEST_SHARD_COMPARISON')));
    assert.throws(() => compare(candidateLog(900) + candidateLog(901)), /completed full-selection/u);
    assert.throws(() => compare(candidateLog(900)
        + 'NODE_FOUNDATION_TEST_SHARD_COMPARISON source=observed_run telemetry_known=400/530 observed_wall_ms=901\nNODE_FOUNDATION_TEST_OK\n'), /completed full-selection/u);
    assert.throws(() => evaluateWallTimeBaseline(baseline, baselineLog, [candidateLog(900)]), /Exactly two/u);
    assert.throws(() => evaluateWallTimeBaseline(baseline, baselineLog, [candidateLog(900), candidateLog(900)]), /distinct/u);
    assert.throws(() => compare(candidateLog(900), `${candidateLog(900)}\n`), /separate shard runs/u);
    assert.throws(() => compare(candidateLog(900), candidateLog(901)), /separate shard runs/u);
    assert.throws(() => compare(candidateLog(900).replace('C:\\test-shards', 'D:\\other-shards')), /same checkout root/u);
    const posixBaselineLog = candidateLog(1000, 531).replace('C:\\test-shards\\run-1', '/workspace/.node-build/test-shard-logs/run-1');
    const posixCandidate = candidateLog(900, 532, 2).replace('C:\\test-shards\\run-2', '/workspace/.node-build/test-shard-logs/run-2');
    const posixSecondCandidate = candidateLog(901, 532, 3).replace('C:\\test-shards\\run-3', '/workspace/.node-build/test-shard-logs/run-3');
    assert.doesNotThrow(() => compare(posixCandidate, posixSecondCandidate, {
        ...baseline,
        source_log_sha256: crypto.createHash('sha256').update(posixBaselineLog).digest('hex')
    }, posixBaselineLog));
    assert.throws(() => compare(candidateLog(900), candidateLog(951, 532, 2)), /exceeds the baseline speedup limit/u);
});

test('wall-time baseline verifies retained source log provenance and measurements', () => {
    assert.throws(() => compare(candidateLog(900), candidateLog(900, 532, 2), { ...baseline, source_log_sha256: 'bad' }), /Baseline source log SHA-256/u);
    assert.throws(() => compare(candidateLog(900), candidateLog(900, 532, 2), baseline, `${baselineLog}extra`), /does not match the retained log/u);
    assert.throws(() => compare(candidateLog(900), candidateLog(900, 532, 2), { ...baseline, observed_wall_ms: 1001 }), /Baseline measurements/u);
    assert.throws(() => compare(candidateLog(900), candidateLog(900, 532, 2), { ...baseline, candidate_log_sha256: ['c'.repeat(64), 'd'.repeat(64)] }), /Candidate quality log SHA-256/u);
    assert.throws(() => compare(candidateLog(900), candidateLog(900, 532, 2), { ...baseline, candidate_source_sha256: 'c'.repeat(64) }), /Candidate source SHA-256/u);
});

test('wall-time baseline binds repeated samples to comparable machine conditions', () => {
    assert.throws(() => compare(candidateLog(900).replace(environmentFingerprint, 'b'.repeat(64))), /environment differs/u);
    assert.throws(() => compare(candidateLog(900).replace('cpu_busy_percent=20.0', 'cpu_busy_percent=9.9')), /materially quieter/u);
    assert.throws(() => compare(candidateLog(900).replace('exit_code=0', 'exit_code=1')), /malformed or incomplete/u);
    assert.throws(() => compare(candidateLog(900).replace('start_utc=2026-09-23T00:02:00.000Z', 'start_utc=2026-09-23T00:00:00.000Z')), /separate sequential/u);
    assert.throws(() => compare(candidateLog(900), candidateLog(900, 532, 2), { ...baseline, environment_fingerprint_sha256: 'b'.repeat(64) }), /tracked fingerprint/u);
});

test('quality capture records its environment and protects retained evidence', (context) => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wall-time-capture-'));
    context.after(() => {
        const resolved = fs.realpathSync(fixtureRoot);
        const temporaryRoot = fs.realpathSync(os.tmpdir());
        assert.ok(resolved.startsWith(`${temporaryRoot}${path.sep}`));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
        name: 'quality-capture-fixture',
        version: '1.0.0',
        scripts: { quality: 'node -e "console.log(\'capture-smoke\')"' }
    }));
    fs.mkdirSync(path.join(fixtureRoot, 'scripts', 'node-foundation'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'scripts', 'node-foundation', 'test.ts'), 'candidate source fixture\n');
    const logPath = path.join(fixtureRoot, 'quality.log');
    const args = [
        path.join(process.cwd(), 'scripts/node-foundation/check-test-wall-time-baseline.cjs'),
        'capture', fixtureRoot, logPath, process.cwd()
    ];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
    assert.equal(first.status, 0, first.stderr);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /capture-smoke/u);
    assert.match(log, /NODE_FOUNDATION_QUALITY_ENVIRONMENT schema=2 fingerprint=[a-f0-9]{64} source_sha256=[a-f0-9]{64} .*exit_code=0 signal=none/u);
    const second = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000 });
    assert.notEqual(second.status, 0);
    assert.equal(fs.readFileSync(logPath, 'utf8'), log);

    const unavailablePreload = path.join(fixtureRoot, 'unavailable-cpu.cjs');
    fs.writeFileSync(unavailablePreload, "require('node:os').cpus = () => [{ model: 'capture-fixture', speed: 1000, times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }];\n");
    const unavailableLogPath = path.join(fixtureRoot, 'unavailable-quality.log');
    const unavailable = spawnSync(process.execPath, [args[0], 'capture', fixtureRoot, unavailableLogPath, process.cwd()], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, NODE_OPTIONS: `--require="${unavailablePreload.replaceAll(path.sep, '/')}"` }
    });
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stderr, /Quality capture produced unavailable CPU telemetry/u);
    assert.doesNotMatch(unavailable.stdout, /QUALITY_CAPTURE_COMPLETED/u);
    assert.match(fs.readFileSync(unavailableLogPath, 'utf8'), /cpu_busy_percent=unavailable/u);
});
