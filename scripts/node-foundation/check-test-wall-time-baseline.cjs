const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FULL_RUN_MARKER = /^NODE_FOUNDATION_TEST_SHARD_COMPARISON source=observed_run\b/u;
const QUALITY_COMMAND_MARKER = /^> garda-agent-orchestrator@\S+ quality$/u;
const TEST_COMMAND_MARKER = /^> garda-agent-orchestrator@\S+ test$/u;
const SHARD_LOG_DIR_MARKER = /^NODE_FOUNDATION_TEST_SHARD_LOG_DIR\b/u;
const PARTIAL_SELECTION_MARKER = /^NODE_FOUNDATION_TEST_DURATION_TELEMETRY_UPDATE_SKIPPED reason=partial_test_selection\b/u;
const ENVIRONMENT_MARKER = /^NODE_FOUNDATION_QUALITY_ENVIRONMENT\b/u;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_QUIETER_CANDIDATE_CPU_BUSY_DELTA = 10;
const CANDIDATE_SOURCE_PATH = path.join('scripts', 'node-foundation', 'test.ts');

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function readPositiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive safe integer.`);
    }
    return value;
}

function parseObservedRun(log, minimumFileCount, minimumKnownFileCount) {
    const lines = log.split(/\r?\n/u);
    const matches = lines
        .map((line, index) => {
            if (!FULL_RUN_MARKER.test(line)) return null;
            const files = /\btelemetry_known=(\d+)\/(\d+)\b/u.exec(line);
            const wall = /\bobserved_wall_ms=(\d+)\b/u.exec(line);
            return files && wall ? {
                lineIndex: index,
                knownFiles: Number(files[1]),
                files: Number(files[2]),
                wallMs: Number(wall[1])
            } : null;
        })
        .filter((item) => item
            && item.files >= minimumFileCount
            && item.knownFiles >= minimumKnownFileCount);
    const firstContentLine = lines.find((line) => line.trim()) || '';
    const lastObservedRunLine = lines.findLastIndex((line) => FULL_RUN_MARKER.test(line));
    const testCommandLine = lines.findIndex((line) => TEST_COMMAND_MARKER.test(line));
    const firstShardLogDirLine = lines.findIndex((line, index) => index > testCommandLine && SHARD_LOG_DIR_MARKER.test(line));
    if (
        matches.length !== 1
        || matches[0].lineIndex !== lastObservedRunLine
        || !QUALITY_COMMAND_MARKER.test(firstContentLine)
        || testCommandLine < 0
        || firstShardLogDirLine < 0
        || firstShardLogDirLine >= matches[0].lineIndex
        || lines.slice(testCommandLine + 1, firstShardLogDirLine).some((line) => PARTIAL_SELECTION_MARKER.test(line))
        || !lines.slice(matches[0].lineIndex + 1).includes('NODE_FOUNDATION_TEST_OK')
    ) {
        throw new Error('Candidate log must contain one completed full-selection observed run.');
    }
    const shardLogDir = lines[firstShardLogDirLine].replace(SHARD_LOG_DIR_MARKER, '').trim();
    const shardRun = /^(.*)[\\/]run-(\d+)$/u.exec(shardLogDir);
    if (!shardRun || !shardRun[1]) {
        throw new Error('Completed quality log must identify its shard run directory.');
    }
    return {
        files: readPositiveInteger(matches[0].files, 'Candidate file count'),
        wallMs: readPositiveInteger(matches[0].wallMs, 'Candidate wall time'),
        shardLogRoot: shardRun[1],
        shardRunId: shardRun[2]
    };
}

function parseQualityEnvironment(log) {
    const lines = log.split(/\r?\n/u);
    const markers = lines.filter((line) => ENVIRONMENT_MARKER.test(line));
    if (markers.length !== 1 || lines.findLast((line) => line.trim()) !== markers[0]) {
        throw new Error('Quality log must end with one execution environment marker.');
    }
    const fields = Object.fromEntries(markers[0].split(' ').slice(1).map((part) => {
        const separator = part.indexOf('=');
        return [part.slice(0, separator), part.slice(separator + 1)];
    }));
    const busyPercent = Number(fields.cpu_busy_percent);
    const startMs = Date.parse(fields.start_utc);
    const endMs = Date.parse(fields.end_utc);
    if (!['1', '2'].includes(fields.schema)
        || !/^[a-f0-9]{64}$/u.test(fields.fingerprint || '')
        || fields.exit_code !== '0'
        || fields.signal !== 'none'
        || !Number.isFinite(busyPercent) || busyPercent < 0 || busyPercent > 100
        || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
        || !Number.isSafeInteger(Number(fields.cpu_count)) || Number(fields.cpu_count) <= 0
        || !Number.isSafeInteger(Number(fields.available_parallelism)) || Number(fields.available_parallelism) <= 0
        || !Number.isSafeInteger(Number(fields.total_memory_bytes)) || Number(fields.total_memory_bytes) <= 0) {
        throw new Error('Quality execution environment marker is malformed or incomplete.');
    }
    if (fields.schema === '2' && !/^[a-f0-9]{64}$/u.test(fields.source_sha256 || '')) {
        throw new Error('Quality candidate source SHA-256 is malformed or missing.');
    }
    return { fingerprint: fields.fingerprint, busyPercent, startMs, endMs, sourceSha256: fields.source_sha256 || null };
}

function evaluateWallTimeBaseline(baseline, baselineLog, candidateLogs) {
    if (baseline.schema_version !== 2 || baseline.source_command !== 'npm run quality') {
        throw new Error('Unsupported wall-time baseline contract.');
    }
    const baselineMs = readPositiveInteger(baseline.observed_wall_ms, 'Baseline wall time');
    if (!/^[a-f0-9]{64}$/u.test(baseline.source_log_sha256 || '')) {
        throw new Error('Baseline source log SHA-256 must be a lowercase hex digest.');
    }
    const sourceLogSha256 = sha256(baselineLog);
    if (sourceLogSha256 !== baseline.source_log_sha256) {
        throw new Error('Baseline source log SHA-256 does not match the retained log.');
    }
    const maxWallTimeRatio = baseline.max_wall_time_ratio;
    if (typeof maxWallTimeRatio !== 'number' || !Number.isFinite(maxWallTimeRatio) || maxWallTimeRatio <= 0 || maxWallTimeRatio >= 1) {
        throw new Error('Maximum wall-time ratio must be a finite number between 0 and 1.');
    }
    const minimumFileCount = readPositiveInteger(baseline.selected_file_count, 'Baseline file count');
    const minimumKnownFileCount = readPositiveInteger(baseline.minimum_known_file_count, 'Baseline known file count');
    const recordedBaseline = parseObservedRun(baselineLog, minimumFileCount, minimumKnownFileCount);
    const baselineEnvironment = parseQualityEnvironment(baselineLog);
    if (recordedBaseline.files !== minimumFileCount || recordedBaseline.wallMs !== baselineMs) {
        throw new Error('Baseline measurements do not match the retained source log.');
    }
    if (baselineEnvironment.fingerprint !== baseline.environment_fingerprint_sha256) {
        throw new Error('Baseline execution environment does not match the tracked fingerprint.');
    }
    if (!Array.isArray(candidateLogs) || candidateLogs.length !== 2) {
        throw new Error('Exactly two independently retained candidate quality logs are required.');
    }
    const candidateDigests = candidateLogs.map(sha256);
    if (candidateDigests[0] === candidateDigests[1]) {
        throw new Error('Candidate quality logs must be distinct.');
    }
    if (!Array.isArray(baseline.candidate_log_sha256)
        || baseline.candidate_log_sha256.length !== 2
        || baseline.candidate_log_sha256.some((digest) => !/^[a-f0-9]{64}$/u.test(digest))) {
        throw new Error('Exactly two tracked candidate log SHA-256 digests are required.');
    }
    if (!/^[a-f0-9]{64}$/u.test(baseline.candidate_source_sha256 || '')) {
        throw new Error('Tracked candidate source SHA-256 is required.');
    }
    if (candidateDigests.some((digest, index) => digest !== baseline.candidate_log_sha256[index])) {
        throw new Error('Candidate quality log SHA-256 does not match the tracked digest.');
    }
    const candidates = candidateLogs.map((log) => parseObservedRun(log, minimumFileCount, minimumKnownFileCount));
    const candidateEnvironments = candidateLogs.map(parseQualityEnvironment);
    if (candidates[0].shardLogRoot !== candidates[1].shardLogRoot) {
        throw new Error('Candidate shard logs must come from the same checkout root.');
    }
    if (new Set([recordedBaseline, ...candidates].map((run) => `${run.shardLogRoot}/${run.shardRunId}`)).size !== 3) {
        throw new Error('Baseline and candidate logs must identify separate shard runs.');
    }
    if (candidateEnvironments.some((environment) => environment.fingerprint !== baselineEnvironment.fingerprint)) {
        throw new Error('Candidate hardware and runtime environment differs from the baseline.');
    }
    if (candidateEnvironments.some((environment) => environment.sourceSha256 !== baseline.candidate_source_sha256)) {
        throw new Error('Candidate source SHA-256 does not match the tracked implementation.');
    }
    if (candidateEnvironments.some((environment) => environment.busyPercent < baselineEnvironment.busyPercent - MAX_QUIETER_CANDIDATE_CPU_BUSY_DELTA)) {
        throw new Error('Candidate host CPU load is materially quieter than the baseline.');
    }
    const orderedEnvironments = [baselineEnvironment, ...candidateEnvironments];
    if (orderedEnvironments.some((environment, index) => index > 0 && environment.startMs <= orderedEnvironments[index - 1].endMs)) {
        throw new Error('Quality samples must be separate sequential runs.');
    }
    const candidateMs = Math.max(...candidates.map((candidate) => candidate.wallMs));
    if (candidateMs > baselineMs * maxWallTimeRatio) {
        throw new Error(`Candidate wall time exceeds the baseline speedup limit: ${candidateMs} ms > ${maxWallTimeRatio} x ${baselineMs} ms.`);
    }
    return {
        baselineMs,
        candidateMs,
        candidateSamples: candidates.length,
        environmentFingerprint: baselineEnvironment.fingerprint,
        selectedFiles: Math.min(...candidates.map((candidate) => candidate.files)),
        deltaMs: candidateMs - baselineMs,
        ratio: Number((candidateMs / baselineMs).toFixed(2))
    };
}

async function captureQualityRun(args) {
    if (args.length !== 3) {
        throw new Error('Usage: node scripts/node-foundation/check-test-wall-time-baseline.cjs capture <checkout> <output.log> <dependency-root>');
    }
    const [checkout, logPath, dependencyRoot] = args;
    const sourcePath = path.join(checkout, CANDIDATE_SOURCE_PATH);
    const sourceSha256 = sha256(fs.readFileSync(sourcePath));
    const cpus = os.cpus();
    const staticEnvironment = {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        node: process.version,
        cpuModel: cpus[0]?.model,
        cpuCount: cpus.length,
        availableParallelism: os.availableParallelism(),
        totalMemory: os.totalmem(),
        hostname: os.hostname()
    };
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(staticEnvironment)).digest('hex');
    const startUtc = new Date().toISOString();
    const fd = fs.openSync(logPath, 'wx');
    const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run quality'] : ['run', 'quality'];
    let result;
    try {
        result = await new Promise((resolve, reject) => {
            const child = spawn(command, commandArgs, {
                cwd: checkout,
                env: {
                    ...process.env,
                    PATH: `${path.join(dependencyRoot, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH || ''}`
                },
                stdio: ['ignore', fd, fd],
                windowsHide: true
            });
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({ code, signal }));
        });
    } finally {
        fs.closeSync(fd);
    }
    if (sha256(fs.readFileSync(sourcePath)) !== sourceSha256) {
        throw new Error(`Candidate source changed during quality capture; retained log: ${logPath}`);
    }
    const endCpus = os.cpus();
    let elapsed = 0;
    let idle = 0;
    for (let index = 0; index < endCpus.length; index += 1) {
        const before = cpus[index].times;
        const after = endCpus[index].times;
        idle += after.idle - before.idle;
        elapsed += Object.keys(after).reduce((sum, key) => sum + after[key] - before[key], 0);
    }
    const busyPercent = elapsed > 0 ? ((1 - idle / elapsed) * 100).toFixed(1) : 'unavailable';
    const exitCode = result.code === null ? 1 : result.code;
    fs.appendFileSync(logPath, `\nNODE_FOUNDATION_QUALITY_ENVIRONMENT schema=2 fingerprint=${fingerprint} source_sha256=${sourceSha256} platform=${process.platform} arch=${process.arch} node=${process.version} cpu_count=${staticEnvironment.cpuCount} available_parallelism=${staticEnvironment.availableParallelism} total_memory_bytes=${staticEnvironment.totalMemory} cpu_busy_percent=${busyPercent} start_utc=${startUtc} end_utc=${new Date().toISOString()} exit_code=${exitCode} signal=${result.signal || 'none'}\n`);
    if (exitCode !== 0) {
        throw new Error(`Quality capture failed with exit code ${exitCode}; retained log: ${logPath}`);
    }
    if (busyPercent === 'unavailable') {
        throw new Error(`Quality capture produced unavailable CPU telemetry; retained log: ${logPath}`);
    }
    process.stdout.write(`QUALITY_CAPTURE_COMPLETED log=${logPath} exit_code=0\n`);
}

function main(args) {
    if (args[0] === 'capture') {
        return captureQualityRun(args.slice(1));
    }
    if (args.length !== 4) {
        throw new Error('Usage: node scripts/node-foundation/check-test-wall-time-baseline.cjs <baseline.json> <baseline-quality.log> <candidate-quality-1.log> <candidate-quality-2.log>');
    }
    const [baselinePath, sourcePath, ...candidatePaths] = args;
    if ([sourcePath, ...candidatePaths].some((file) => fs.statSync(file).size > MAX_LOG_BYTES)) {
        throw new Error('Quality log exceeds the 64 MiB inspection limit.');
    }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const baselineLog = fs.readFileSync(sourcePath, 'utf8');
    const candidateLogs = candidatePaths.map((file) => fs.readFileSync(file, 'utf8'));
    const result = evaluateWallTimeBaseline(baseline, baselineLog, candidateLogs);
    process.stdout.write(`WALL_TIME_BASELINE_PASSED baseline_ms=${result.baselineMs} candidate_ms=${result.candidateMs} candidate_samples=${result.candidateSamples} delta_ms=${result.deltaMs} ratio=${result.ratio} selected_files=${result.selectedFiles}\n`);
}

if (require.main === module) {
    Promise.resolve().then(() => main(process.argv.slice(2))).catch((error) => {
        process.stderr.write(`WALL_TIME_BASELINE_ERROR ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { evaluateWallTimeBaseline };
