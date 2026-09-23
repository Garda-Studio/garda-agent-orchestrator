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

function installedTreeRoot(dependencyRoot) {
    const checkoutRoot = fs.realpathSync(dependencyRoot);
    const expected = path.join(checkoutRoot, 'node_modules');
    const actual = fs.realpathSync(path.join(dependencyRoot, 'node_modules'));
    if (process.platform === 'win32'
        ? actual.toLowerCase() !== expected.toLowerCase()
        : actual !== expected) {
        throw new Error('Installed node_modules root resolves outside the quality checkout.');
    }
    return actual;
}

function dependencySha256(checkout, dependencyRoot) {
    installedTreeRoot(dependencyRoot);
    const hash = crypto.createHash('sha256');
    for (const [label, file] of [
        ['package-lock.json', path.join(checkout, 'package-lock.json')],
        ['node_modules/.package-lock.json', path.join(dependencyRoot, 'node_modules', '.package-lock.json')]
    ]) {
        hash.update(`${label}\0`);
        hash.update(fs.readFileSync(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function installedTreeEvidence(dependencyRoot) {
    const hash = crypto.createHash('sha256');
    const treeRoot = installedTreeRoot(dependencyRoot);
    let fileCount = 0;
    let latestMtimeMs = 0;
    function hashEntry(kind, relative, contents, mode) {
        const name = Buffer.from(relative, 'utf8');
        const length = Buffer.alloc(8);
        hash.update(kind);
        length.writeBigUInt64BE(BigInt(name.length));
        hash.update(length).update(name);
        length.writeBigUInt64BE(BigInt(mode));
        hash.update(length);
        length.writeBigUInt64BE(BigInt(contents.length));
        hash.update(length).update(contents);
    }
    function visit(directory, relativeDirectory) {
        const directoryStat = fs.statSync(directory);
        hashEntry('D', relativeDirectory, Buffer.alloc(0), directoryStat.mode);
        latestMtimeMs = Math.max(latestMtimeMs, directoryStat.mtimeMs, directoryStat.ctimeMs);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
            const fullPath = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                const target = fs.realpathSync(fullPath);
                const targetRelative = path.relative(treeRoot, target);
                if (targetRelative.startsWith(`..${path.sep}`) || targetRelative === '..' || path.isAbsolute(targetRelative)) {
                    throw new Error(`Installed dependency tree contains a link outside its root: ${relative}`);
                }
                const stat = fs.lstatSync(fullPath);
                hashEntry('L', relative, Buffer.from(fs.readlinkSync(fullPath), 'utf8'), stat.mode);
                latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs, stat.ctimeMs);
                fileCount += 1;
            }
            if (entry.isDirectory()) {
                visit(fullPath, relative);
            } else if (entry.isFile()) {
                const stat = fs.statSync(fullPath);
                hashEntry('F', relative, fs.readFileSync(fullPath), stat.mode);
                latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs, stat.ctimeMs);
                fileCount += 1;
            }
        }
    }
    visit(treeRoot, '');
    if (fileCount === 0) throw new Error('Installed dependency tree is empty.');
    return { sha256: hash.digest('hex'), fileCount, latestMtimeMs };
}

function requireCheckoutDependencyRoot(checkout, dependencyRoot) {
    const normalizedCheckout = path.resolve(checkout);
    const normalizedDependencyRoot = path.resolve(dependencyRoot);
    if (process.platform === 'win32'
        ? normalizedCheckout.toLowerCase() !== normalizedDependencyRoot.toLowerCase()
        : normalizedCheckout !== normalizedDependencyRoot) {
        throw new Error('Candidate dependency root must be the quality checkout.');
    }
    if (fs.realpathSync(checkout) !== fs.realpathSync(dependencyRoot)) {
        throw new Error('Candidate dependency root must be the quality checkout.');
    }
}

function candidateCheckoutFromLog(log, minimumFileCount, minimumKnownFileCount) {
    const shardRoot = parseObservedRun(log, minimumFileCount, minimumKnownFileCount).shardLogRoot;
    if (!path.isAbsolute(shardRoot)) {
        throw new Error('Candidate shard run directory must be an absolute path.');
    }
    if (path.basename(shardRoot) !== 'test-shard-logs'
        || path.basename(path.dirname(shardRoot)) !== '.node-build') {
        throw new Error('Candidate shard run directory must be under checkout .node-build/test-shard-logs.');
    }
    return path.dirname(path.dirname(shardRoot));
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
    if (!['1', '2', '3'].includes(fields.schema)
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
    if (fields.schema === '3' && (!/^[a-f0-9]{64}$/u.test(fields.source_sha256 || '')
        || !/^[a-f0-9]{64}$/u.test(fields.dependency_sha256 || ''))) {
        throw new Error('Quality candidate source or dependency SHA-256 is malformed or missing.');
    }
    return { schema: fields.schema, fingerprint: fields.fingerprint, busyPercent, startMs, endMs,
        sourceSha256: fields.source_sha256 || null, dependencySha256: fields.dependency_sha256 || null };
}

function assertRetainedLogIntegrity(baseline, baselineLog, candidateLogs) {
    if (baseline.schema_version !== 2 || baseline.source_command !== 'npm run quality') {
        throw new Error('Unsupported wall-time baseline contract.');
    }
    if (!/^[a-f0-9]{64}$/u.test(baseline.source_log_sha256 || '')) {
        throw new Error('Baseline source log SHA-256 must be a lowercase hex digest.');
    }
    const sourceLogSha256 = sha256(baselineLog);
    if (sourceLogSha256 !== baseline.source_log_sha256) {
        throw new Error('Baseline source log SHA-256 does not match the retained log.');
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
    if (!/^[a-f0-9]{64}$/u.test(baseline.candidate_dependency_sha256 || '')) {
        throw new Error('Tracked candidate dependency SHA-256 is required.');
    }
    if (candidateDigests.some((digest, index) => digest !== baseline.candidate_log_sha256[index])) {
        throw new Error('Candidate quality log SHA-256 does not match the tracked digest.');
    }
}

function evaluateWallTimeBaseline(baseline, baselineLog, candidateLogs, installedEvidence) {
    assertRetainedLogIntegrity(baseline, baselineLog, candidateLogs);
    const baselineMs = readPositiveInteger(baseline.observed_wall_ms, 'Baseline wall time');
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
    const candidates = candidateLogs.map((log) => parseObservedRun(log, minimumFileCount, minimumKnownFileCount));
    const candidateEnvironments = candidateLogs.map(parseQualityEnvironment);
    if (candidateEnvironments.some((environment) => environment.schema !== '3')) {
        throw new Error('Candidate quality environment must use dependency-bound schema 3.');
    }
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
    if (candidateEnvironments.some((environment) => environment.dependencySha256 !== baseline.candidate_dependency_sha256)) {
        throw new Error('Candidate dependency SHA-256 does not match the tracked installation.');
    }
    if (!/^[a-f0-9]{64}$/u.test(baseline.candidate_dependency_tree_postrun_sha256 || '')
        || !Number.isSafeInteger(baseline.candidate_dependency_tree_file_count)
        || baseline.candidate_dependency_tree_file_count <= 0) {
        throw new Error('Tracked post-run dependency content attestation is incomplete.');
    }
    if (!installedEvidence
        || installedEvidence.sha256 !== baseline.candidate_dependency_tree_postrun_sha256
        || installedEvidence.fileCount !== baseline.candidate_dependency_tree_file_count) {
        throw new Error('Installed dependency content does not match the tracked post-run attestation.');
    }
    if (!Number.isFinite(installedEvidence.latestMtimeMs)
        || installedEvidence.latestMtimeMs >= candidateEnvironments[0].startMs) {
        throw new Error('Installed dependency content was modified after the candidate runs began.');
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
    requireCheckoutDependencyRoot(checkout, dependencyRoot);
    const sourcePath = path.join(checkout, CANDIDATE_SOURCE_PATH);
    const sourceSha256 = sha256(fs.readFileSync(sourcePath));
    const installedDependencySha256 = dependencySha256(checkout, dependencyRoot);
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
    if (dependencySha256(checkout, dependencyRoot) !== installedDependencySha256) {
        throw new Error(`Candidate dependency installation changed during quality capture; retained log: ${logPath}`);
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
    fs.appendFileSync(logPath, `\nNODE_FOUNDATION_QUALITY_ENVIRONMENT schema=3 fingerprint=${fingerprint} source_sha256=${sourceSha256} dependency_sha256=${installedDependencySha256} platform=${process.platform} arch=${process.arch} node=${process.version} cpu_count=${staticEnvironment.cpuCount} available_parallelism=${staticEnvironment.availableParallelism} total_memory_bytes=${staticEnvironment.totalMemory} cpu_busy_percent=${busyPercent} start_utc=${startUtc} end_utc=${new Date().toISOString()} exit_code=${exitCode} signal=${result.signal || 'none'}\n`);
    if (exitCode !== 0) {
        throw new Error(`Quality capture failed with exit code ${exitCode}; retained log: ${logPath}`);
    }
    if (busyPercent === 'unavailable') {
        throw new Error(`Quality capture produced unavailable CPU telemetry; retained log: ${logPath}`);
    }
    if (!Number.isFinite(Number(busyPercent)) || Number(busyPercent) < 0 || Number(busyPercent) > 100) {
        throw new Error(`Quality capture produced invalid CPU telemetry; retained log: ${logPath}`);
    }
    const dependencyTree = installedTreeEvidence(dependencyRoot);
    process.stdout.write(`QUALITY_CAPTURE_COMPLETED log=${logPath} exit_code=0 candidate_dependency_tree_postrun_sha256=${dependencyTree.sha256} candidate_dependency_tree_file_count=${dependencyTree.fileCount}\n`);
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
    assertRetainedLogIntegrity(baseline, baselineLog, candidateLogs);
    const dependencyRoot = path.resolve(path.dirname(baselinePath), baseline.candidate_dependency_root || '.');
    for (const log of candidateLogs) {
        requireCheckoutDependencyRoot(candidateCheckoutFromLog(log, baseline.selected_file_count, baseline.minimum_known_file_count), dependencyRoot);
    }
    if (dependencySha256(dependencyRoot, dependencyRoot) !== baseline.candidate_dependency_sha256) {
        throw new Error('Current checkout dependency lock snapshot does not match the candidate logs.');
    }
    const result = evaluateWallTimeBaseline(baseline, baselineLog, candidateLogs, installedTreeEvidence(dependencyRoot));
    process.stdout.write(`WALL_TIME_BASELINE_PASSED baseline_ms=${result.baselineMs} candidate_ms=${result.candidateMs} candidate_samples=${result.candidateSamples} delta_ms=${result.deltaMs} ratio=${result.ratio} selected_files=${result.selectedFiles}\n`);
}

if (require.main === module) {
    Promise.resolve().then(() => main(process.argv.slice(2))).catch((error) => {
        process.stderr.write(`WALL_TIME_BASELINE_ERROR ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { evaluateWallTimeBaseline, installedTreeEvidence };
