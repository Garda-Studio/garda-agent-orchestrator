import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import type { ChildProcess, SpawnSyncReturns, SpawnSyncOptions, StdioOptions } from 'node:child_process';

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;         // 60 s for routine git ops
export const DEFAULT_GIT_CLONE_TIMEOUT_MS = 300_000;  // 5 min for clone/fetch
export const DEFAULT_NPM_TIMEOUT_MS = 300_000;        // 5 min for npm operations
export const DEFAULT_COMPILE_TIMEOUT_MS = 600_000;    // 10 min for compile/test/lint

export interface SpawnStreamedOptions {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
    envMode?: 'merge' | 'replace';
    onSpawn?: (child: SpawnedProcessInfo) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    inheritStdio?: boolean;
    maxBuffer?: number;
    capturePolicy?: OutputCapturePolicy;
}

export interface SpawnedProcessInfo {
    pid: number | null;
    command: string;
    args: readonly string[];
    shell: boolean;
}

export interface SpawnStreamedResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    stdoutOriginalBytes: number;
    stderrOriginalBytes: number;
}

export interface OutputCapturePolicy {
    mode: 'full-buffer' | 'head-tail';
    maxBytes?: number;
    headBytes?: number;
    tailBytes?: number;
}

export interface CapturedOutput {
    text: string;
    truncated: boolean;
    originalBytes: number;
}

function notifySpawnedProcess(
    callback: ((child: SpawnedProcessInfo) => void) | undefined,
    info: SpawnedProcessInfo
): void {
    try {
        callback?.(info);
    } catch (_error) {
        // Spawn observers are diagnostic hooks and must not disrupt child lifecycle cleanup.
    }
}

const PROCESS_TERMINATION_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const WINDOWS_PROCESS_TREE_QUERY_TIMEOUT_MS = 5_000;
const WINDOWS_PROCESS_TREE_FALLBACK_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class GardaProcessTree {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct PROCESSENTRY32 {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    private static List<Tuple<uint, uint>> SnapshotPairs() {
        var pairs = new List<Tuple<uint, uint>>();
        IntPtr snapshot = CreateToolhelp32Snapshot(0x00000002, 0);
        if (snapshot == new IntPtr(-1)) return pairs;
        try {
            var entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(entry);
            if (Process32First(snapshot, ref entry)) {
                do { pairs.Add(Tuple.Create(entry.th32ProcessID, entry.th32ParentProcessID)); }
                while (Process32Next(snapshot, ref entry));
            }
            return pairs;
        } finally { CloseHandle(snapshot); }
    }
    public static int Terminate(uint rootPid) {
        const uint PROCESS_TERMINATE = 0x0001;
        const uint SYNCHRONIZE = 0x00100000;
        var known = new HashSet<uint>();
        var handles = new Dictionary<uint, IntPtr>();
        IntPtr rootHandle = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, false, rootPid);
        if (rootHandle == IntPtr.Zero) return -1;
        known.Add(rootPid);
        handles.Add(rootPid, rootHandle);
        int quietPasses = 0;
        try {
            for (int pass = 0; pass < 8 && quietPasses < 2; pass++) {
                bool discovered = false;
                var pairs = SnapshotPairs();
                bool expanded;
                do {
                    expanded = false;
                    foreach (var pair in pairs) {
                        uint processId = pair.Item1;
                        uint parentId = pair.Item2;
                        if (!known.Contains(parentId) || known.Contains(processId)) continue;
                        known.Add(processId);
                        IntPtr handle = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, false, processId);
                        if (handle != IntPtr.Zero) handles[processId] = handle;
                        discovered = true;
                        expanded = true;
                    }
                } while (expanded);
                foreach (var handle in handles.Values) TerminateProcess(handle, 1);
                quietPasses = discovered ? 0 : quietPasses + 1;
                Thread.Sleep(25);
            }
            return handles.Count;
        } finally {
            foreach (var handle in handles.Values) CloseHandle(handle);
        }
    }
}
'@
[GardaProcessTree]::Terminate([uint32]$env:GARDA_PROCESS_TREE_ROOT_PID)
`;

function terminateWindowsProcessTreeFallback(rootPid: number): boolean {
    if (!Number.isInteger(rootPid) || rootPid <= 0) {
        return false;
    }
    try {
        const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
        const powershellPath = path.join(
            windowsRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe'
        );
        const output = childProcess.execFileSync(powershellPath, [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(WINDOWS_PROCESS_TREE_FALLBACK_SCRIPT, 'utf16le').toString('base64')
        ], {
            encoding: 'utf8',
            env: { ...process.env, GARDA_PROCESS_TREE_ROOT_PID: String(rootPid) },
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: WINDOWS_PROCESS_TREE_QUERY_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        });
        const terminatedCount = Number(output.trim());
        return Number.isInteger(terminatedCount) && terminatedCount > 0;
    } catch (_error) {
        return false;
    }
}

function killWindowsProcessTree(child: ChildProcess): void {
    if (!child.pid) {
        return;
    }
    try {
        childProcess.execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 5000
        });
        return;
    } catch (_error) {
        if (child.exitCode !== null || child.signalCode !== null) {
            return;
        }
        terminateWindowsProcessTreeFallback(child.pid);
        try { child.kill('SIGKILL'); } catch (_killError) { /* Already exited. */ }
    }
}

function sliceChunkToFit(chunk: string, maxBytes: number): string {
    if (maxBytes <= 0 || chunk.length === 0) {
        return '';
    }

    let usedBytes = 0;
    let prefix = '';
    for (const symbol of chunk) {
        const symbolBytes = Buffer.byteLength(symbol, 'utf8');
        if (usedBytes + symbolBytes > maxBytes) {
            break;
        }
        prefix += symbol;
        usedBytes += symbolBytes;
    }
    return prefix;
}

function sliceChunkTailToFit(chunk: string, maxBytes: number): string {
    if (maxBytes <= 0 || chunk.length === 0) {
        return '';
    }

    let usedBytes = 0;
    let suffix = '';
    const symbols = Array.from(chunk);
    for (let index = symbols.length - 1; index >= 0; index -= 1) {
        const symbol = symbols[index];
        const symbolBytes = Buffer.byteLength(symbol, 'utf8');
        if (usedBytes + symbolBytes > maxBytes) {
            break;
        }
        suffix = symbol + suffix;
        usedBytes += symbolBytes;
    }
    return suffix;
}

function resolveCapturePolicy(maxBuffer: number, policy?: OutputCapturePolicy): Required<OutputCapturePolicy> {
    const mode = policy?.mode || 'head-tail';
    const maxBytes = Math.max(0, policy?.maxBytes ?? maxBuffer);
    if (mode === 'full-buffer') {
        return {
            mode,
            maxBytes,
            headBytes: maxBytes,
            tailBytes: 0
        };
    }
    const defaultHeadBytes = Math.floor(maxBytes / 2);
    const defaultTailBytes = maxBytes - defaultHeadBytes;
    return {
        mode,
        maxBytes,
        headBytes: Math.max(0, policy?.headBytes ?? defaultHeadBytes),
        tailBytes: Math.max(0, policy?.tailBytes ?? defaultTailBytes)
    };
}

function createOutputCapture(maxBuffer: number, capturePolicy?: OutputCapturePolicy): {
    append(chunk: string): void;
    finish(): CapturedOutput;
} {
    const policy = resolveCapturePolicy(maxBuffer, capturePolicy);
    const chunks: string[] = [];
    let bufferedBytes = 0;
    let originalBytes = 0;
    let truncated = false;
    let headText = '';
    let tailText = '';

    function switchToHeadTail(incomingChunk: string): void {
        const combined = `${chunks.join('')}${incomingChunk}`;
        headText = sliceChunkToFit(combined, policy.headBytes);
        tailText = sliceChunkTailToFit(combined, policy.tailBytes);
        chunks.length = 0;
        bufferedBytes = 0;
        truncated = true;
    }

    return {
        append(chunk: string): void {
            const chunkBytes = Buffer.byteLength(chunk, 'utf8');
            originalBytes += chunkBytes;
            if (policy.mode === 'full-buffer') {
                const remainingBytes = policy.maxBytes - bufferedBytes;
                if (remainingBytes > 0) {
                    const partial = sliceChunkToFit(chunk, remainingBytes);
                    if (partial.length > 0) {
                        chunks.push(partial);
                        bufferedBytes += Buffer.byteLength(partial, 'utf8');
                    }
                }
                truncated = truncated || bufferedBytes < originalBytes;
                return;
            }

            if (!truncated) {
                if (bufferedBytes + chunkBytes <= policy.maxBytes) {
                    chunks.push(chunk);
                    bufferedBytes += chunkBytes;
                    return;
                }
                switchToHeadTail(chunk);
                return;
            }

            tailText = sliceChunkTailToFit(`${tailText}${chunk}`, policy.tailBytes);
        },
        finish(): CapturedOutput {
            if (!truncated) {
                return {
                    text: chunks.join(''),
                    truncated: false,
                    originalBytes
                };
            }
            if (policy.mode === 'full-buffer') {
                return {
                    text: chunks.join(''),
                    truncated: true,
                    originalBytes
                };
            }
            const capturedBytes = Buffer.byteLength(headText, 'utf8') + Buffer.byteLength(tailText, 'utf8');
            const omittedBytes = Math.max(0, originalBytes - capturedBytes);
            const marker = `\n[... output truncated; omitted ${omittedBytes} bytes ...]\n`;
            return {
                text: `${headText}${marker}${tailText}`,
                truncated: true,
                originalBytes
            };
        }
    };
}

const WINDOWS_BATCH_FILE_PATTERN = /\.(?:cmd|bat)$/i;
const WINDOWS_BATCH_UNSAFE_LITERAL_PATTERN = /[\0\r\n%!"]/u;
const WINDOWS_BATCH_QUOTED_TOKEN_PATTERN = /[ \t"&|<>()^]/u;

function quoteWindowsBatchArgument(argument: string): string {
    const text = String(argument ?? '');
    let escaped = '"';
    let backslashCount = 0;
    for (const character of text) {
        if (character === '\\') {
            backslashCount += 1;
            continue;
        }
        if (character === '"') {
            escaped += '\\'.repeat(backslashCount * 2 + 1);
            escaped += '"';
            backslashCount = 0;
            continue;
        }
        if (backslashCount > 0) {
            escaped += '\\'.repeat(backslashCount);
            backslashCount = 0;
        }
        escaped += character;
    }
    if (backslashCount > 0) {
        escaped += '\\'.repeat(backslashCount * 2);
    }
    escaped += '"';
    return escaped;
}

function formatWindowsBatchToken(argument: string, alwaysQuote = false): string {
    const text = String(argument ?? '');
    if (!alwaysQuote && text && !WINDOWS_BATCH_QUOTED_TOKEN_PATTERN.test(text)) {
        return text;
    }
    return quoteWindowsBatchArgument(text);
}

function assertSafeWindowsBatchLiteral(value: string, label: string): void {
    if (!value) {
        throw new Error(`${label} must not be empty.`);
    }
    if (WINDOWS_BATCH_UNSAFE_LITERAL_PATTERN.test(value)) {
        throw new Error(
            `${label} contains cmd.exe expansion, delayed expansion, quote, or control characters (` +
            'percent signs, exclamation marks, quotes, CR, or LF) that are not allowed for Windows batch execution without a proven escaping strategy.'
        );
    }
}

function assertBatchCommandToken(commandToken: string, label: string, requireAbsolute = false): string {
    const normalized = String(commandToken || '').trim();
    if (!normalized) {
        throw new Error(`${label} must not be empty.`);
    }
    if (requireAbsolute && !path.isAbsolute(normalized)) {
        throw new Error(`Windows batch execution requires an absolute executable path. Received: ${commandToken}`);
    }
    if (!WINDOWS_BATCH_FILE_PATTERN.test(normalized)) {
        throw new Error(
            `spawnShellCommand is restricted to Windows .cmd/.bat execution. Received: ${commandToken}`
        );
    }
    assertSafeWindowsBatchLiteral(normalized, label);
    return normalized;
}

function getWindowsCommandProcessor(): string {
    return process.env.ComSpec || 'cmd.exe';
}

export function buildWindowsBatchCommandLine(executablePath: string, args: readonly string[] = []): string {
    const batchCommandToken = assertBatchCommandToken(executablePath, 'Batch command token');
    const commandParts = ['call', formatWindowsBatchToken(batchCommandToken)];
    for (let index = 0; index < args.length; index += 1) {
        const argument = String(args[index] ?? '');
        assertSafeWindowsBatchLiteral(argument, `Batch argument #${index + 1}`);
        commandParts.push(formatWindowsBatchToken(argument));
    }
    return commandParts.join(' ');
}

export function spawnStreamed(command: string, args: string[], options?: SpawnStreamedOptions): Promise<SpawnStreamedResult> {
    const opts = options || {};
    const cwd = opts.cwd || process.cwd();
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 0;
    const signal = opts.signal || null;
    const maxBuffer = opts.maxBuffer || 20 * 1024 * 1024;
    const inheritStdio = opts.inheritStdio || false;

    return new Promise(function (resolve, reject) {
        if (signal && signal.aborted) {
            return resolve({
                exitCode: 1,
                stdout: '',
                stderr: '',
                timedOut: false,
                cancelled: true,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutOriginalBytes: 0,
                stderrOriginalBytes: 0
            });
        }

        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const stdoutCapture = createOutputCapture(maxBuffer, opts.capturePolicy);
        const stderrCapture = createOutputCapture(maxBuffer, opts.capturePolicy);

        const spawnOpts: {
            cwd: string;
            windowsHide: boolean;
            stdio: StdioOptions;
            env?: NodeJS.ProcessEnv;
            detached?: boolean;
        } = {
            cwd,
            windowsHide: true,
            stdio: inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32'
        };
        if (opts.env) {
            spawnOpts.env = opts.envMode === 'replace' ? opts.env : { ...process.env, ...opts.env };
        }

        const child: ChildProcess = childProcess.spawn(command, args, spawnOpts);
        notifySpawnedProcess(opts.onSpawn, {
            pid: child.pid ?? null,
            command,
            args,
            shell: false
        });

        function cleanup(): void {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
            process.removeListener('exit', onParentExit);
            for (const terminationSignal of PROCESS_TERMINATION_SIGNALS) {
                process.removeListener(terminationSignal, onParentTermination);
            }
        }

        function killChild(force = false): void {
            if (!child.pid) {
                return;
            }
            try {
                if (process.platform === 'win32') {
                    killWindowsProcessTree(child);
                } else {
                    try {
                        process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
                    } catch (_e) {
                        child.kill(force ? 'SIGKILL' : 'SIGTERM');
                    }
                    if (!force) {
                        const forceKillHandle = setTimeout(function () {
                            try { process.kill(-child.pid!, 'SIGKILL'); } catch (_e) {
                                try { child.kill('SIGKILL'); } catch (_inner) { /* already exited */ }
                            }
                        }, 3000);
                        forceKillHandle.unref?.();
                    }
                }
            } catch (_e) {
                // Child already exited
            }
        }

        function settle(result: SpawnStreamedResult): void {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        }

        function onAbort(): void {
            if (settled) return;
            cancelled = true;
            killChild();
        }

        function onParentExit(): void {
            if (!settled) {
                killChild(true);
            }
        }

        function onParentTermination(): void {
            if (!settled) {
                killChild(true);
            }
            process.exit(1);
        }

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }
        process.once('exit', onParentExit);
        for (const terminationSignal of PROCESS_TERMINATION_SIGNALS) {
            process.once(terminationSignal, onParentTermination);
        }

        if (timeoutMs > 0) {
            timeoutHandle = setTimeout(function () {
                if (settled) return;
                timedOut = true;
                killChild();
            }, timeoutMs);
        }

        child.once('error', function (error: NodeJS.ErrnoException) {
            cleanup();
            if (settled) return;
            settled = true;
            if (error && error.code === 'ENOENT') {
                reject(new Error(`'${command}' is required but was not found in PATH.`));
            } else {
                reject(error);
            }
        });

        if (!inheritStdio) {
            if (child.stdout) {
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', function (chunk: string) {
                    stdoutCapture.append(chunk);
                    if (opts.onStdout) {
                        opts.onStdout(chunk);
                    }
                });
            }
            if (child.stderr) {
                child.stderr.setEncoding('utf8');
                child.stderr.on('data', function (chunk: string) {
                    stderrCapture.append(chunk);
                    if (opts.onStderr) {
                        opts.onStderr(chunk);
                    }
                });
            }
        }

        child.once('close', function (code: number | null) {
            const stdout = stdoutCapture.finish();
            const stderr = stderrCapture.finish();
            settle({
                exitCode: code == null ? 1 : code,
                stdout: stdout.text,
                stderr: stderr.text,
                timedOut,
                cancelled,
                stdoutTruncated: stdout.truncated,
                stderrTruncated: stderr.truncated,
                stdoutOriginalBytes: stdout.originalBytes,
                stderrOriginalBytes: stderr.originalBytes
            });
        });
    });
}

// Shell execution is intentionally NOT exposed in the general-purpose
// SpawnStreamedOptions interface.  This helper confines shell semantics
// to the single scenario that genuinely requires them: running Windows
// .cmd/.bat executables where the OS needs cmd.exe to resolve the script.
//
// Callers must supply the resolved batch executable path and literal argument
// array. This helper owns the cmd.exe command-line construction so future
// call sites cannot widen shell semantics by assembling raw command strings.

export interface SpawnShellCommandOptions {
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string | undefined>;
    onSpawn?: (child: SpawnedProcessInfo) => void;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    maxBuffer?: number;
    capturePolicy?: OutputCapturePolicy;
}

export function spawnShellCommand(
    executablePath: string,
    args: string[] = [],
    options?: SpawnShellCommandOptions
): Promise<SpawnStreamedResult> {
    if (process.platform !== 'win32') {
        return Promise.reject(new Error(
            'spawnShellCommand is restricted to Windows batch-file execution. ' +
            'Use spawnStreamed for cross-platform commands.'
        ));
    }
    const opts = options || {};
    const cwd = opts.cwd || process.cwd();
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 0;
    const signal = opts.signal || null;
    const maxBuffer = opts.maxBuffer || 20 * 1024 * 1024;
    const batchExecutablePath = assertBatchCommandToken(executablePath, 'Batch executable path', true);
    const commandLine = buildWindowsBatchCommandLine(batchExecutablePath, args);

    return new Promise(function (resolve, reject) {
        if (signal && signal.aborted) {
            return resolve({
                exitCode: 1,
                stdout: '',
                stderr: '',
                timedOut: false,
                cancelled: true,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutOriginalBytes: 0,
                stderrOriginalBytes: 0
            });
        }

        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const stdoutCapture = createOutputCapture(maxBuffer, opts.capturePolicy);
        const stderrCapture = createOutputCapture(maxBuffer, opts.capturePolicy);

        const spawnOptions: {
            cwd: string;
            windowsHide: boolean;
            stdio: ['ignore', 'pipe', 'pipe'];
            env?: NodeJS.ProcessEnv;
            windowsVerbatimArguments: boolean;
        } = {
            cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsVerbatimArguments: true
        };
        if (opts.env) {
            spawnOptions.env = { ...process.env, ...opts.env };
        }
        const shellCommand = getWindowsCommandProcessor();
        const shellArgs = ['/d', '/s', '/c', commandLine];
        const child: ChildProcess = childProcess.spawn(shellCommand, shellArgs, spawnOptions);
        notifySpawnedProcess(opts.onSpawn, {
            pid: child.pid ?? null,
            command: shellCommand,
            args: shellArgs,
            shell: true
        });

        function cleanup(): void {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (signal) {
                signal.removeEventListener('abort', onAbort);
            }
            process.removeListener('exit', onParentExit);
            for (const terminationSignal of PROCESS_TERMINATION_SIGNALS) {
                process.removeListener(terminationSignal, onParentTermination);
            }
        }

        function killChild(_force = false): void {
            if (!child.pid) {
                return;
            }
            try {
                killWindowsProcessTree(child);
            } catch (_e) {
                // Child already exited
            }
        }

        function settle(result: SpawnStreamedResult): void {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        }

        function onAbort(): void {
            if (settled) return;
            cancelled = true;
            killChild();
        }

        function onParentExit(): void {
            if (!settled) {
                killChild(true);
            }
        }

        function onParentTermination(): void {
            if (!settled) {
                killChild(true);
            }
            process.exit(1);
        }

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }
        process.once('exit', onParentExit);
        for (const terminationSignal of PROCESS_TERMINATION_SIGNALS) {
            process.once(terminationSignal, onParentTermination);
        }

        if (timeoutMs > 0) {
            timeoutHandle = setTimeout(function () {
                if (settled) return;
                timedOut = true;
                killChild();
            }, timeoutMs);
        }

        child.once('error', function (error: NodeJS.ErrnoException) {
            cleanup();
            if (settled) return;
            settled = true;
            reject(error);
        });

        if (child.stdout) {
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', function (chunk: string) {
                stdoutCapture.append(chunk);
                if (opts.onStdout) {
                    opts.onStdout(chunk);
                }
            });
        }
        if (child.stderr) {
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', function (chunk: string) {
                stderrCapture.append(chunk);
                if (opts.onStderr) {
                    opts.onStderr(chunk);
                }
            });
        }

        child.once('close', function (code: number | null) {
            const stdout = stdoutCapture.finish();
            const stderr = stderrCapture.finish();
            settle({
                exitCode: code == null ? 1 : code,
                stdout: stdout.text,
                stderr: stderr.text,
                timedOut,
                cancelled,
                stdoutTruncated: stdout.truncated,
                stderrTruncated: stderr.truncated,
                stdoutOriginalBytes: stdout.originalBytes,
                stderrOriginalBytes: stderr.originalBytes
            });
        });
    });
}

export interface SpawnSyncWithTimeoutOptions extends SpawnSyncOptions {
    timeoutMs?: number;
}

export interface SpawnSyncWithTimeoutResult extends SpawnSyncReturns<string> {
    timedOut: boolean;
}

export function spawnSyncWithTimeout(command: string, args: string[], options?: SpawnSyncWithTimeoutOptions): SpawnSyncWithTimeoutResult {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || 0;
    const passThrough: SpawnSyncOptions & { timeoutMs?: number } = { ...opts };
    delete passThrough.timeoutMs;

    if (timeoutMs > 0) {
        passThrough.timeout = timeoutMs;
    }
    if (passThrough.windowsHide === undefined) {
        passThrough.windowsHide = true;
    }

    const result = childProcess.spawnSync(command, args, passThrough) as SpawnSyncWithTimeoutResult;

    // spawnSync sets result.signal === 'SIGTERM' on timeout
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        result.timedOut = true;
    } else if (result.signal === 'SIGTERM' && timeoutMs > 0) {
        result.timedOut = true;
    } else {
        result.timedOut = false;
    }

    return result;
}
