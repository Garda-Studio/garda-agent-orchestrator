'use strict';

const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const bounded = value => String(value || '').slice(0, 8_192);
const emit = (name, value) => console.log(JSON.stringify({ kind: 'windows-native-diagnostic', name, ...value }));
const clock = () => ({ utc_ms: Date.now(), monotonic_utc_ms: performance.timeOrigin + performance.now() });

function installNativeTrace() {
    if (process.platform !== 'win32') return;
    const system32 = path.join(fs.realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot'), 'System32');
    const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const acl = path.join(system32, 'icacls.exe');
    const originalExecFile = cp.execFile;
    const originalSpawnSync = cp.spawnSync;
    emit('failed_case_host', { pid: process.pid, node: process.version, ...clock() });
    cp.spawnSync = function (command, args, options) {
        const started = performance.now();
        const result = Reflect.apply(originalSpawnSync, this, arguments);
        if ([powershell, acl].includes(String(command))) {
            emit('failed_case_native_sync', { command, elapsed_ms: performance.now() - started,
                timeout_ms: options?.timeout, status: result.status, error_code: result.error?.code,
                stderr: bounded(result.stderr), ...clock() });
        }
        return result;
    };
    cp.execFile = function (command, args, options, callback) {
        if (command !== powershell || typeof callback !== 'function') return Reflect.apply(originalExecFile, this, arguments);
        const started = performance.now();
        return originalExecFile.call(this, command, args, options, function (error, stdout, stderr) {
            emit('failed_case_native_async', { command, elapsed_ms: performance.now() - started,
                timeout_ms: options.timeout, error_code: error?.code, killed: error?.killed,
                owned_targets: bounded(options.env?.GARDA_PROCESS_TREE_TARGETS), stdout: bounded(stdout),
                stderr: bounded(stderr), script_sha256: crypto.createHash('sha256').update(String(args.at(-1))).digest('hex'), ...clock() });
            if (error || String(stdout).trim() === '0') {
                try {
                    const observation = originalSpawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
foreach ($target in $env:GARDA_PROCESS_TREE_TARGETS.Split(';')) {
    $fields = $target.Split(','); $targetPid = 0
    if ($fields.Length -ne 3 -or -not [int]::TryParse($fields[0], [ref]$targetPid)) { continue }
    try {
        $process = [Diagnostics.Process]::GetProcessById($targetPid)
        $created = ([double]$process.StartTime.ToUniversalTime().Ticks / 10000.0) - 62135596800000.0
        [Console]::WriteLine($targetPid.ToString() + '|' + $created.ToString('R', [Globalization.CultureInfo]::InvariantCulture))
    } catch { [Console]::WriteLine($targetPid.ToString() + '|unavailable') }
}
`], { env: options.env, encoding: 'utf8', timeout: 2_500, windowsHide: true, maxBuffer: 256 * 1024 });
                    emit('failed_case_root_creation_observation', { qualification: 'Read-only observation after unsuccessful production helper; no termination or acceptance evidence.',
                        status: observation.status, error_code: observation.error?.code, stdout: bounded(observation.stdout), stderr: bounded(observation.stderr), ...clock() });
                } catch (observationError) {
                    emit('failed_case_root_creation_observation', { status: 'unavailable', error: bounded(observationError.message), ...clock() });
                }
            }
            callback.call(this, error, stdout, stderr);
        });
    };
}

function run() {
    if (process.platform !== 'win32') throw Error('Failed native case diagnosis requires Windows.');
    const root = path.resolve(__dirname, '../..');
    const preload = '--require ' + JSON.stringify(__filename);
    const started = performance.now();
    const result = cp.spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-name-pattern',
        'adversarial PATH taskkill replacement|slow review reads release the transaction lock',
        '.node-build/tests/node/core/subprocess.test.js', '.node-build/tests/node/gate-runtime/review-artifacts.test.js'], {
        cwd: root, env: { ...process.env, GARDA_TRACE_NATIVE_FAILURES: '1', NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' ') },
        encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    emit('failed_native_cases_summary', { elapsed_ms: performance.now() - started, status: result.status,
        signal: result.signal, error_code: result.error?.code, full_release_validation: false });
    if (result.status !== 0 || result.error) process.exitCode = 1;
}

module.exports = { run };
if (process.env.GARDA_TRACE_NATIVE_FAILURES === '1') installNativeTrace();
else if (require.main === module) run();
