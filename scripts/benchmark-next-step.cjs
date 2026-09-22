#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const MAX_SAMPLE_COUNT = 30;
const taskId = process.argv[2];
const repoRoot = path.resolve(process.argv[3] || '.');
const sampleCount = Number(process.argv[4] || 6);
if (!taskId || !Number.isInteger(sampleCount) || sampleCount < 6 || sampleCount > MAX_SAMPLE_COUNT) {
    process.stderr.write(`Usage: node scripts/benchmark-next-step.cjs <task-id> [repo-root] [sample-count=6..${MAX_SAMPLE_COUNT}]\n`);
    process.exit(2);
}

const cliPath = path.resolve(__dirname, '..', 'bin', 'garda.js');
const durationsMs = [];
let expectedOutput = null;
let route = null;
for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = process.hrtime.bigint();
    const run = spawnSync(process.execPath, [
        cliPath, 'next-step', taskId, '--repo-root', repoRoot, '--as-json'
    ], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
    });
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (run.error || run.status !== 0) {
        process.stderr.write(run.stderr || String(run.error || `next-step exited ${run.status}`));
        process.exit(run.status || 1);
    }
    const parsed = JSON.parse(run.stdout);
    const { generated_utc: _generatedUtc, ...stableOutput } = parsed;
    const normalizedOutput = JSON.stringify(stableOutput);
    if (expectedOutput !== null && normalizedOutput !== expectedOutput) {
        process.stderr.write(`next-step output changed between samples 1 and ${index + 1}\n`);
        process.exit(1);
    }
    expectedOutput = normalizedOutput;
    route = parsed.next_gate;
    durationsMs.push(Math.round(durationMs));
}

const laterSamples = durationsMs.slice(1).sort((left, right) => left - right);
const medianIndex = Math.floor(laterSamples.length / 2);
const medianMs = laterSamples.length % 2 === 0
    ? (laterSamples[medianIndex - 1] + laterSamples[medianIndex]) / 2
    : laterSamples[medianIndex];
const result = {
    task_id: taskId,
    route,
    node_version: process.version,
    process_count: sampleCount,
    first_ms: durationsMs[0],
    subsequent_ms: durationsMs.slice(1),
    subsequent_median_ms: medianMs,
    subsequent_range_ms: [laterSamples[0], laterSamples[laterSamples.length - 1]],
    output_equivalent: true,
    excluded_volatile_fields: ['generated_utc'],
    normalized_output_sha256: createHash('sha256').update(expectedOutput).digest('hex')
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
