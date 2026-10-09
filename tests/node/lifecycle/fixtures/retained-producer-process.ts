import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import type { TestContext } from 'node:test';

interface ProducerOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; args?: string[]; maxBuffer?: number; }
interface Retention { pid: number; directory: string; readonly exited: boolean; }
interface SupervisorState { child?: ChildProcess; error?: Error; }
export interface RetainedProducerResult extends SpawnSyncReturns<string> { retention?: Retention; }
const pause = new Int32Array(new SharedArrayBuffer(4));
const MAX_PRODUCER_TIMEOUT_MS = 60000;
const DEFAULT_PRODUCER_TIMEOUT_MS = 30000;
const MAX_BUFFER_BYTES = 1024 * 1024;
const EXIT_WAIT_MS = 5000;
const FORCED_EXIT_WAIT_MS = 2000;
const RESPONSE_GRACE_MS = 12000;
const RETENTION_LIMIT_MS = 15 * 60 * 1000;

// Windows keeps an exited PID reserved until every handle to that process closes.
const supervisorScript = String.raw`
$ErrorActionPreference = 'Stop'
$requestPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('<REQUEST>'))
$request = [IO.File]::ReadAllText($requestPath) | ConvertFrom-Json
$producer = New-Object Diagnostics.Process
$owner = [Diagnostics.Process]::GetProcessById($request.ownerPid)
$started = $false
try {
    $producer.StartInfo.FileName = $request.executable
    $producer.StartInfo.Arguments = '"' + $request.script + '"'
    $producer.StartInfo.WorkingDirectory = $request.cwd
    $producer.StartInfo.UseShellExecute = $false
    $producer.StartInfo.CreateNoWindow = $true
    $producer.StartInfo.RedirectStandardOutput = $true
    $producer.StartInfo.RedirectStandardError = $true
    $producer.StartInfo.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $producer.StartInfo.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $producer.StartInfo.EnvironmentVariables.Clear()
    foreach ($variable in $request.env.PSObject.Properties) {
        $producer.StartInfo.EnvironmentVariables[$variable.Name] = [string]$variable.Value
    }
    $started = $producer.Start()
    if (!$started) { throw 'Producer did not start' }
    $retainedHandle = $producer.Handle
    $ownerHandle = $owner.Handle
    $stdoutBuffer = New-Object char[] ($request.maxBuffer + 1)
    $stderrBuffer = New-Object char[] ($request.maxBuffer + 1)
    $stdout = $producer.StandardOutput.ReadBlockAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
    $stderr = $producer.StandardError.ReadBlockAsync($stderrBuffer, 0, $stderrBuffer.Length)
    $childDeadline = [DateTime]::UtcNow.AddMilliseconds($request.timeout)
    $timedOut = $false
    while (!$producer.WaitForExit(20)) {
        $overflow = ($stdout.IsCompleted -and $stdout.Result -gt $request.maxBuffer) -or ($stderr.IsCompleted -and $stderr.Result -gt $request.maxBuffer)
        $timedOut = [DateTime]::UtcNow -ge $childDeadline
        if ($overflow -or $timedOut) { break }
    }
    if (!$producer.HasExited) {
        $producer.Kill()
        if (!$producer.WaitForExit($request.exitWaitMs)) { throw 'Producer did not terminate after timeout' }
    }
    if (![Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdout, $stderr)).Wait($request.exitWaitMs)) {
        throw 'Producer output did not close'
    }
    $status = $null
    if (!$timedOut) { $status = $producer.ExitCode }
    $reply = @{pid=$producer.Id; status=$status; stdout=[string]::new($stdoutBuffer,0,$stdout.Result); stderr=[string]::new($stderrBuffer,0,$stderr.Result); timedOut=$timedOut}
    [IO.File]::WriteAllText($request.reply + '.pending', ($reply | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    [IO.File]::Move($request.reply + '.pending', $request.reply)
    $deadline = [DateTime]::UtcNow.AddMilliseconds($request.retentionMs)
    while (![IO.File]::Exists($request.release) -and !$owner.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        [Threading.Thread]::Sleep(20)
    }
} catch {
    if (![IO.File]::Exists($request.reply)) {
        [IO.File]::WriteAllText($request.reply + '.pending', (@{failure=$_.Exception.Message} | ConvertTo-Json -Compress))
        [IO.File]::Move($request.reply + '.pending', $request.reply)
    }
    exit 1
} finally {
    if ($started -and !$producer.HasExited) { $producer.Kill() }
    $producer.Dispose()
    $owner.Dispose()
}
`;

function waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
        const finish = (exited: boolean) => {
            clearTimeout(timer);
            child.off('exit', onExit);
            resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeout);
        child.once('exit', onExit);
    });
}

function registerCleanup(context: Pick<TestContext, 'after'>, state: SupervisorState, directory: string): void {
    context.after(async () => {
        try {
            const child = state.child;
            if (!child) return;
            fs.writeFileSync(path.join(directory, 'release'), 'release');
            if (!await waitForExit(child, EXIT_WAIT_MS)) {
                child.kill();
                await waitForExit(child, FORCED_EXIT_WAIT_MS);
                throw new Error('Retained producer supervisor failed to release its native handle');
            }
            if (state.error) throw state.error;
            if (child.exitCode !== 0) throw new Error('Retained producer supervisor failed during native cleanup');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
}

function writeProducerInput(directory: string, code: string, options: ProducerOptions, timeout: number): string {
    const script = path.join(directory, 'producer.cjs');
    // File execution avoids Windows command-line limits while preserving -e argument layout.
    fs.writeFileSync(script, 'process.argv=[process.execPath,...' + JSON.stringify(options.args ?? []) + '];\n' + code, 'utf8');
    const requestPath = path.join(directory, 'request.json');
    fs.writeFileSync(requestPath, JSON.stringify({ executable: process.execPath, script,
        reply: path.join(directory, 'reply.json'), release: path.join(directory, 'release'),
        ownerPid: process.pid, timeout, maxBuffer: options.maxBuffer ?? MAX_BUFFER_BYTES,
        exitWaitMs: EXIT_WAIT_MS, retentionMs: RETENTION_LIMIT_MS,
        cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env }), 'utf8');
    return Buffer.from(requestPath).toString('base64');
}

function readReply(replyPath: string, deadline: number): Record<string, unknown> {
    while (!fs.existsSync(replyPath) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 10);
    if (!fs.existsSync(replyPath)) throw new Error('Retained producer supervisor exceeded its response deadline');
    const reply = JSON.parse(fs.readFileSync(replyPath, 'utf8').replace(/^\uFEFF/u, ''));
    if (reply.failure) throw new Error('Retained producer supervisor: ' + String(reply.failure));
    if (!Number.isSafeInteger(reply.pid) || reply.pid < 1 || typeof reply.stdout !== 'string'
        || typeof reply.stderr !== 'string' || typeof reply.timedOut !== 'boolean'
        || (reply.status !== null && !Number.isInteger(reply.status))) {
        throw new Error('Retained producer supervisor returned an invalid exit record');
    }
    return reply;
}

export function runRetainedProducer(context: Pick<TestContext, 'after'>, code: string, options: ProducerOptions = {}): RetainedProducerResult {
    const timeout = options.timeout ?? DEFAULT_PRODUCER_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_PRODUCER_TIMEOUT_MS) throw new Error('Invalid producer timeout');
    const maxBuffer = options.maxBuffer ?? MAX_BUFFER_BYTES;
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > MAX_BUFFER_BYTES) throw new Error('Invalid producer maxBuffer');
    if (process.platform !== 'win32') return spawnSync(process.execPath, ['-e', code, ...options.args ?? []], { ...options, timeout, encoding: 'utf8' });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-retained-producer-'));
    const state: SupervisorState = {};
    registerCleanup(context, state, directory);
    const replyPath = path.join(directory, 'reply.json');
    const request = writeProducerInput(directory, code, options, timeout);
    const command = Buffer.from(supervisorScript.replace('<REQUEST>', request), 'utf16le').toString('base64');
    const executable = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
        stdio: 'ignore', windowsHide: true
    });
    state.child = child;
    child.once('error', error => { state.error = error; });
    child.unref();
    if (!child.pid) throw new Error('Retained producer supervisor did not start');
    const reply = readReply(replyPath, Date.now() + timeout + RESPONSE_GRACE_MS);
    const oversized = Buffer.byteLength(reply.stdout as string) + Buffer.byteLength(reply.stderr as string) > maxBuffer;
    const error = reply.timedOut ? Object.assign(new Error('Producer timed out'), { code: 'ETIMEDOUT' })
        : oversized ? Object.assign(new Error('Producer output exceeded maxBuffer'), { code: 'ENOBUFS' }) : undefined;
    return {
        pid: reply.pid as number, status: error ? null : reply.status as number | null, signal: reply.timedOut ? 'SIGTERM' : null,
        stdout: reply.stdout as string, stderr: reply.stderr as string,
        output: [null, reply.stdout as string, reply.stderr as string], error,
        retention: { pid: child.pid, directory, get exited() { return child.exitCode !== null || child.signalCode !== null; } }
    };
}
