import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcess, SpawnSyncReturns, SpawnSyncOptions, StdioOptions } from 'node:child_process';

export const DEFAULT_GIT_TIMEOUT_MS = 60_000;         // 60 s for routine git ops
export const DEFAULT_GIT_CLONE_TIMEOUT_MS = 300_000;  // 5 min for clone/fetch
export const DEFAULT_NPM_TIMEOUT_MS = 300_000;        // 5 min for npm operations
export const DEFAULT_COMPILE_TIMEOUT_MS = 600_000;    // 10 min for compile/test/lint

export interface SpawnStreamedOptions {
    outputSink?: { write(stream: 'stdout' | 'stderr', chunk: Buffer, signal: AbortSignal): Promise<void> };
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
    sinkError?: string;
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

const PROCESS_TERMINATION_SIGNALS: NodeJS.Signals[] = process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];
const WINDOWS_PROCESS_TREE_COMMAND_TIMEOUT_MS = 2_500;
export const WINDOWS_PROCESS_TREE_TARGET_BATCH_MAX_CHARS = 12_000;
export const WINDOWS_EXIT_CLEANUP_BUDGET_MS = 2_500;
const WINDOWS_SYSTEM32_ROOT = process.platform === 'win32'
    ? path.join(fs.realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot'), 'System32')
    : '';
const CHILD_GRACEFUL_TERMINATION_MS = 3_000;
export const SUBPROCESS_TERMINATION_TIMEOUT_MS = 6_000;
export const SHUTDOWN_CLEANUP_CONCURRENCY = 4;
const SIGNAL_EXIT_CODE_MAP: Readonly<Record<string, number>> = Object.freeze({
    SIGHUP: 1,
    SIGINT: 2,
    SIGPIPE: 13,
    SIGTERM: 15,
    SIGBREAK: 21,
    SIGWINCH: 28
});

interface ManagedChildProcess {
    child: ChildProcess;
    creationWindowStartUtcMs: number;
    creationWindowEndUtcMs: number;
    closed: Promise<void>;
    resolveClosed: () => void;
    gracefulTerminationStarted: boolean;
    forceTermination: Promise<void> | null;
    forceKillHandle: ReturnType<typeof setTimeout> | null;
    released: boolean;
}

export type SubprocessSignalHandler = (
    signal: NodeJS.Signals,
    cleanup: Promise<void>
) => void;

const activeChildren = new Set<ManagedChildProcess>();
const installedTerminationSignals = new Set<NodeJS.Signals>();
let subprocessSignalHandler: SubprocessSignalHandler | null = null;
let processExitListenerInstalled = false;
let acceptingChildren = true;
let terminationCleanup: Promise<void> | null = null;
const pendingWindowsForceTerminations = new Map<ManagedChildProcess, () => void>();
let windowsForceDrainScheduled = false;
let windowsForceDrainRunning = false;
const WINDOWS_PROCESS_TREE_FALLBACK_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
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
    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
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
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FILETIME creation,
        out FILETIME exit,
        out FILETIME kernel,
        out FILETIME user
    );
    [DllImport("kernel32.dll")]
    private static extern void GetSystemTimePreciseAsFileTime(out FILETIME systemTimeAsFileTime);
    private sealed class ProcessSnapshot {
        public readonly List<Tuple<uint, uint>> Pairs = new List<Tuple<uint, uint>>();
        public ulong ExistingBeforeFileTime;
    }
    private static ulong ToFileTimeTicks(FILETIME value) {
        return ((ulong)value.dwHighDateTime << 32) | value.dwLowDateTime;
    }
    private static ProcessSnapshot SnapshotPairs() {
        var result = new ProcessSnapshot();
        FILETIME snapshotBoundary;
        GetSystemTimePreciseAsFileTime(out snapshotBoundary);
        result.ExistingBeforeFileTime = ToFileTimeTicks(snapshotBoundary);
        IntPtr snapshot = CreateToolhelp32Snapshot(0x00000002, 0);
        if (snapshot == new IntPtr(-1)) return result;
        try {
            var entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(entry);
            if (Process32First(snapshot, ref entry)) {
                do { result.Pairs.Add(Tuple.Create(entry.th32ProcessID, entry.th32ParentProcessID)); }
                while (Process32Next(snapshot, ref entry));
            }
            return result;
        } finally { CloseHandle(snapshot); }
    }
    private static double ToUnixMilliseconds(FILETIME value) {
        ulong fileTime = ToFileTimeTicks(value);
        return (fileTime / 10000.0) - 11644473600000.0;
    }
    private static bool MatchesExpectedCreationWindow(IntPtr process, double earliestUtcMs, double latestUtcMs) {
        FILETIME creation;
        FILETIME exit;
        FILETIME kernel;
        FILETIME user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return false;
        double creationUtcMs = ToUnixMilliseconds(creation);
        return creationUtcMs >= earliestUtcMs - 1.0 && creationUtcMs <= latestUtcMs;
    }
    private static bool MatchesExpectedDescendantInstance(
        IntPtr process,
        double earliestUtcMs,
        ulong existingBeforeFileTime
    ) {
        FILETIME creation;
        FILETIME exit;
        FILETIME kernel;
        FILETIME user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return false;
        return ToUnixMilliseconds(creation) >= earliestUtcMs - 1.0
            && ToFileTimeTicks(creation) <= existingBeforeFileTime;
    }
    private sealed class TerminationTarget {
        public uint RootPid;
        public double EarliestUtcMs;
        public double LatestUtcMs;
    }
    private static List<TerminationTarget> TargetsFromEnvironment() {
        var targets = new List<TerminationTarget>();
        string rawTargets = Environment.GetEnvironmentVariable("GARDA_PROCESS_TREE_TARGETS");
        if (String.IsNullOrWhiteSpace(rawTargets)) return targets;
        foreach (string rawTarget in rawTargets.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries)) {
            string[] fields = rawTarget.Split(',');
            uint rootPid;
            double earliestUtcMs;
            double latestUtcMs;
            if (fields.Length != 3
                || !uint.TryParse(fields[0], NumberStyles.None, CultureInfo.InvariantCulture, out rootPid)
                || !double.TryParse(fields[1], NumberStyles.Float, CultureInfo.InvariantCulture, out earliestUtcMs)
                || !double.TryParse(fields[2], NumberStyles.Float, CultureInfo.InvariantCulture, out latestUtcMs)
                || rootPid == 0
                || double.IsNaN(earliestUtcMs)
                || double.IsInfinity(earliestUtcMs)
                || double.IsNaN(latestUtcMs)
                || double.IsInfinity(latestUtcMs)
                || earliestUtcMs > latestUtcMs) {
                continue;
            }
            targets.Add(new TerminationTarget {
                RootPid = rootPid,
                EarliestUtcMs = earliestUtcMs,
                LatestUtcMs = latestUtcMs
            });
        }
        return targets;
    }
    public static int TerminateFromEnvironment() {
        const uint PROCESS_TERMINATE = 0x0001;
        const uint SYNCHRONIZE = 0x00100000;
        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        var targets = TargetsFromEnvironment();
        if (targets.Count == 0) return 0;
        var earliestByPid = new Dictionary<uint, double>();
        var handles = new Dictionary<uint, IntPtr>();
        var initialSnapshot = SnapshotPairs();
        foreach (var target in targets) {
            if (handles.ContainsKey(target.RootPid)) continue;
            IntPtr rootHandle = OpenProcess(
                PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                target.RootPid
            );
            if (rootHandle == IntPtr.Zero) continue;
            if (!MatchesExpectedCreationWindow(rootHandle, target.EarliestUtcMs, target.LatestUtcMs)) {
                CloseHandle(rootHandle);
                continue;
            }
            handles.Add(target.RootPid, rootHandle);
            earliestByPid.Add(target.RootPid, target.EarliestUtcMs);
        }
        if (handles.Count == 0) return 0;
        int quietPasses = 0;
        try {
            for (int pass = 0; pass < 8 && quietPasses < 2; pass++) {
                bool discovered = false;
                var processSnapshot = pass == 0 ? initialSnapshot : SnapshotPairs();
                var pairs = processSnapshot.Pairs;
                bool expanded;
                do {
                    expanded = false;
                    foreach (var pair in pairs) {
                        uint processId = pair.Item1;
                        uint parentId = pair.Item2;
                        double earliestUtcMs;
                        if (!earliestByPid.TryGetValue(parentId, out earliestUtcMs)
                            || earliestByPid.ContainsKey(processId)) continue;
                        IntPtr handle = OpenProcess(
                            PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                            false,
                            processId
                        );
                        if (handle == IntPtr.Zero) continue;
                        if (!MatchesExpectedDescendantInstance(
                            handle,
                            earliestUtcMs,
                            processSnapshot.ExistingBeforeFileTime
                        )) {
                            CloseHandle(handle);
                            continue;
                        }
                        earliestByPid.Add(processId, earliestUtcMs);
                        handles[processId] = handle;
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
[GardaProcessTree]::TerminateFromEnvironment()
`;

function runExecFile(
    command: string,
    args: readonly string[],
    options: childProcess.ExecFileOptionsWithStringEncoding
): Promise<{ error: NodeJS.ErrnoException | null; stdout: string }> {
    return new Promise(function (resolve) {
        childProcess.execFile(command, [...args], options, function (error, stdout) {
            resolve({
                error: error as NodeJS.ErrnoException | null,
                stdout
            });
        });
    });
}

function windowsProcessTreeTargetBatches(entries: readonly ManagedChildProcess[]): string[] {
    const batches: string[] = [];
    let currentTargets: string[] = [];
    let currentLength = 0;
    for (const entry of entries) {
        if (!entry.child.pid) continue;
        const target = [
            entry.child.pid,
            entry.creationWindowStartUtcMs,
            entry.creationWindowEndUtcMs
        ].join(',');
        if (target.length > WINDOWS_PROCESS_TREE_TARGET_BATCH_MAX_CHARS) continue;
        const separatorLength = currentTargets.length > 0 ? 1 : 0;
        if (currentLength + separatorLength + target.length > WINDOWS_PROCESS_TREE_TARGET_BATCH_MAX_CHARS) {
            batches.push(currentTargets.join(';'));
            currentTargets = [];
            currentLength = 0;
        }
        currentTargets.push(target);
        currentLength += (currentTargets.length > 1 ? 1 : 0) + target.length;
    }
    if (currentTargets.length > 0) batches.push(currentTargets.join(';'));
    return batches;
}

function windowsProcessTreeEnvironment(targets: string): NodeJS.ProcessEnv {
    const windowsRoot = path.dirname(WINDOWS_SYSTEM32_ROOT);
    const environment: NodeJS.ProcessEnv = {
        SystemRoot: windowsRoot,
        WINDIR: windowsRoot,
        GARDA_PROCESS_TREE_TARGETS: targets
    };
    for (const name of ['TEMP', 'TMP'] as const) {
        const value = process.env[name];
        if (value && value.length <= 1_024) environment[name] = value;
    }
    return environment;
}

async function terminateWindowsProcessTrees(entries: readonly ManagedChildProcess[]): Promise<boolean> {
    const targetBatches = windowsProcessTreeTargetBatches(entries);
    if (targetBatches.length === 0) return false;
    const powershellPath = path.join(
        WINDOWS_SYSTEM32_ROOT,
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
    );
    let terminatedAny = false;
    await settleWithShutdownConcurrency(targetBatches, async function (targets) {
        const result = await runExecFile(powershellPath, [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(WINDOWS_PROCESS_TREE_FALLBACK_SCRIPT, 'utf16le').toString('base64')
        ], {
            encoding: 'utf8',
            env: windowsProcessTreeEnvironment(targets),
            windowsHide: true,
            timeout: WINDOWS_PROCESS_TREE_COMMAND_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        });
        if (result.error) return;
        const terminatedCount = Number(result.stdout.trim());
        if (Number.isInteger(terminatedCount) && terminatedCount > 0) terminatedAny = true;
    });
    return terminatedAny;
}

function terminateWindowsProcessTreesSync(
    entries: readonly ManagedChildProcess[],
    timeoutMs: number
): boolean {
    const targetBatches = windowsProcessTreeTargetBatches(entries);
    if (targetBatches.length === 0 || timeoutMs <= 0) return false;
    const powershellPath = path.join(
        WINDOWS_SYSTEM32_ROOT,
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
    );
    const deadline = Date.now() + timeoutMs;
    let terminatedAny = false;
    for (const targets of targetBatches) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        try {
            const output = childProcess.execFileSync(powershellPath, [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-EncodedCommand',
                Buffer.from(WINDOWS_PROCESS_TREE_FALLBACK_SCRIPT, 'utf16le').toString('base64')
            ], {
                encoding: 'utf8',
                env: windowsProcessTreeEnvironment(targets),
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
                timeout: Math.min(remainingMs, WINDOWS_PROCESS_TREE_COMMAND_TIMEOUT_MS),
                maxBuffer: 1024 * 1024
            });
            const terminatedCount = Number(output.trim());
            if (Number.isInteger(terminatedCount) && terminatedCount > 0) terminatedAny = true;
        } catch (_error) {
            // Continue while budget remains so one failed chunk does not starve later identities.
        }
    }
    return terminatedAny;
}

function killWindowsProcessTreesOnExit(entries: readonly ManagedChildProcess[], timeoutMs: number): void {
    if (timeoutMs <= 0) {
        return;
    }
    terminateWindowsProcessTreesSync(entries, timeoutMs);
}

async function drainWindowsForceTerminations(): Promise<void> {
    while (pendingWindowsForceTerminations.size > 0) {
        const scheduledEntries = [...pendingWindowsForceTerminations.entries()];
        pendingWindowsForceTerminations.clear();
        const admittedEntries = scheduledEntries.map(([entry]) => entry);
        try {
            if (admittedEntries.length > 0) {
                await terminateWindowsProcessTrees(admittedEntries);
            }
        } catch (_error) {
            // Shutdown remains best-effort; settle every admitted request so later batches can run.
        } finally {
            for (const [, resolve] of scheduledEntries) resolve();
        }
    }
}

function scheduleWindowsForceTerminationDrain(): void {
    if (windowsForceDrainScheduled || windowsForceDrainRunning) return;
    windowsForceDrainScheduled = true;
    setImmediate(function () {
        windowsForceDrainScheduled = false;
        windowsForceDrainRunning = true;
        void drainWindowsForceTerminations().finally(function () {
            windowsForceDrainRunning = false;
            if (pendingWindowsForceTerminations.size > 0) {
                scheduleWindowsForceTerminationDrain();
            }
        });
    });
}

function enqueueWindowsForceTermination(entry: ManagedChildProcess): Promise<void> {
    if (entry.forceTermination) return entry.forceTermination;
    let resolveTermination = function (): void {};
    entry.forceTermination = new Promise<void>(function (resolve) {
        resolveTermination = resolve;
    });
    pendingWindowsForceTerminations.set(entry, resolveTermination);
    scheduleWindowsForceTerminationDrain();
    return entry.forceTermination;
}

function killPosixProcessGroup(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!child.pid) {
        return;
    }
    try {
        process.kill(-child.pid, signal);
    } catch (_error) {
        try { child.kill(signal); } catch (_inner) { /* Already exited. */ }
    }
}

function forceTerminateManagedChild(entry: ManagedChildProcess): Promise<void> {
    if (entry.forceKillHandle) {
        clearTimeout(entry.forceKillHandle);
        entry.forceKillHandle = null;
    }
    if (!entry.forceTermination) {
        entry.forceTermination = process.platform === 'win32'
            ? enqueueWindowsForceTermination(entry)
            : Promise.resolve(killPosixProcessGroup(entry.child, 'SIGKILL'));
    }
    return entry.forceTermination;
}

function terminateManagedChild(entry: ManagedChildProcess, force: boolean): Promise<void> {
    if (entry.released) {
        return Promise.resolve();
    }
    if (force || process.platform === 'win32') {
        return forceTerminateManagedChild(entry);
    }
    if (!entry.gracefulTerminationStarted) {
        entry.gracefulTerminationStarted = true;
        killPosixProcessGroup(entry.child, 'SIGTERM');
        entry.forceKillHandle = setTimeout(function () {
            void forceTerminateManagedChild(entry);
        }, CHILD_GRACEFUL_TERMINATION_MS);
        entry.forceKillHandle.unref?.();
    }
    return Promise.resolve();
}

function removeCoordinatorSignalListeners(): void {
    for (const signal of installedTerminationSignals) {
        process.removeListener(signal, onProcessTerminationSignal);
    }
    installedTerminationSignals.clear();
}

function synchronizeCoordinatorListeners(): void {
    const signalsRequired = subprocessSignalHandler !== null || activeChildren.size > 0;
    if (signalsRequired && installedTerminationSignals.size === 0) {
        for (const signal of PROCESS_TERMINATION_SIGNALS) {
            try {
                process.on(signal, onProcessTerminationSignal);
                installedTerminationSignals.add(signal);
            } catch (_error) {
                // Some Node/platform combinations do not expose every named signal.
            }
        }
    } else if (!signalsRequired && installedTerminationSignals.size > 0) {
        removeCoordinatorSignalListeners();
    }

    const exitListenerRequired = activeChildren.size > 0;
    if (exitListenerRequired && !processExitListenerInstalled) {
        process.once('exit', onProcessExit);
        processExitListenerInstalled = true;
    } else if (!exitListenerRequired && processExitListenerInstalled) {
        process.removeListener('exit', onProcessExit);
        processExitListenerInstalled = false;
    }
}

function releaseManagedChild(entry: ManagedChildProcess): void {
    if (entry.released) {
        return;
    }
    // The coordinator owns the lifetime of an active ChildProcess. Do not retain
    // a bare PID after close: operating systems can reuse it for an unrelated
    // process, while intentionally detached descendants are outside this active
    // launch contract.
    entry.released = true;
    if (entry.forceKillHandle) {
        clearTimeout(entry.forceKillHandle);
        entry.forceKillHandle = null;
    }
    entry.resolveClosed();
    activeChildren.delete(entry);
    synchronizeCoordinatorListeners();
}

function registerManagedChild(child: ChildProcess, creationWindowStartUtcMs: number): ManagedChildProcess {
    let resolveClosed = function (): void {};
    const closed = new Promise<void>(function (resolve) {
        resolveClosed = resolve;
    });
    const entry: ManagedChildProcess = {
        child,
        creationWindowStartUtcMs,
        creationWindowEndUtcMs: performance.timeOrigin + performance.now(),
        closed,
        resolveClosed,
        gracefulTerminationStarted: false,
        forceTermination: null,
        forceKillHandle: null,
        released: false
    };
    activeChildren.add(entry);
    synchronizeCoordinatorListeners();
    return entry;
}

export async function settleWithShutdownConcurrency<T>(
    items: readonly T[],
    worker: (item: T) => void | Promise<void>
): Promise<void> {
    let nextIndex = 0;
    const workerCount = Math.min(SHUTDOWN_CLEANUP_CONCURRENCY, items.length);
    const workers = Array.from({ length: workerCount }, async function () {
        while (nextIndex < items.length) {
            const item = items[nextIndex];
            nextIndex += 1;
            try {
                await worker(item);
            } catch (_error) {
                // Shutdown is best-effort; one failed cleanup must not starve the remaining queue.
            }
        }
    });
    await Promise.all(workers);
}

function forceTerminateWindowsChildren(entries: readonly ManagedChildProcess[]): Promise<void> {
    return Promise.all(entries.map(function (entry) {
        return terminateManagedChild(entry, true);
    })).then(function () {});
}

function boundedChildCleanup(entries: readonly ManagedChildProcess[]): Promise<void> {
    const termination = process.platform === 'win32'
        ? forceTerminateWindowsChildren(entries)
        : settleWithShutdownConcurrency(entries, function (entry) {
            return terminateManagedChild(entry, true);
        });
    const cleanup = termination.then(function () {
        return Promise.all(entries.map((entry) => entry.closed));
    }).then(function () {});
    return new Promise(function (resolve) {
        let finished = false;
        const timeoutHandle = setTimeout(function () {
            if (finished) return;
            finished = true;
            for (const entry of entries) {
                if (!entry.released && process.platform !== 'win32') {
                    killPosixProcessGroup(entry.child, 'SIGKILL');
                }
            }
            resolve();
        }, SUBPROCESS_TERMINATION_TIMEOUT_MS);
        cleanup.then(function () {
            if (finished) return;
            finished = true;
            clearTimeout(timeoutHandle);
            resolve();
        });
    });
}

export function computeTerminationSignalExitCode(signal: NodeJS.Signals | null): number {
    if (!signal) {
        return 130;
    }
    return 128 + (SIGNAL_EXIT_CODE_MAP[signal] ?? 2);
}

function onProcessTerminationSignal(signal: NodeJS.Signals): void {
    if (terminationCleanup) {
        return;
    }
    acceptingChildren = false;
    terminationCleanup = boundedChildCleanup([...activeChildren]);
    if (subprocessSignalHandler) {
        subprocessSignalHandler(signal, terminationCleanup);
        return;
    }
    void terminationCleanup.then(function () {
        process.exit(computeTerminationSignalExitCode(signal));
    });
}

function onProcessExit(): void {
    processExitListenerInstalled = false;
    if (terminationCleanup) {
        // Signal cleanup already owns termination and its deadline. Re-entering the
        // synchronous exit fallback here would make the signal path unbounded.
        return;
    }
    if (process.platform === 'win32') {
        killWindowsProcessTreesOnExit([...activeChildren], WINDOWS_EXIT_CLEANUP_BUDGET_MS);
        return;
    }
    for (const entry of activeChildren) {
        killPosixProcessGroup(entry.child, 'SIGKILL');
    }
}

export function registerSubprocessSignalHandler(handler: SubprocessSignalHandler): () => void {
    if (subprocessSignalHandler && subprocessSignalHandler !== handler) {
        throw new Error('A subprocess signal handler is already registered.');
    }
    subprocessSignalHandler = handler;
    synchronizeCoordinatorListeners();
    return function dispose(): void {
        if (subprocessSignalHandler !== handler) {
            return;
        }
        subprocessSignalHandler = null;
        if (activeChildren.size === 0) {
            acceptingChildren = true;
            terminationCleanup = null;
        }
        synchronizeCoordinatorListeners();
    };
}

function assertChildAdmission(): void {
    if (!acceptingChildren) {
        throw new Error('Cannot start a child process while process termination is in progress.');
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

export function createOutputCapture(maxBuffer: number, capturePolicy?: OutputCapturePolicy): {
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
        try {
            assertChildAdmission();
        } catch (error) {
            reject(error);
            return;
        }
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
        let sinkError: string | undefined;
        const sinkReads: Promise<void>[] = [];
        let sinkQueue = Promise.resolve();
        const sinkController = new AbortController();
        function awaitSink(write: Promise<void>): Promise<void> {
            const signal = sinkController.signal;
            return new Promise((resolveWrite, rejectWrite) => {
                const abort = (): void => rejectWrite(new Error('Output sink interrupted.'));
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
                void write.then(resolveWrite, rejectWrite).finally(() => signal.removeEventListener('abort', abort));
            });
        }

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

        const creationWindowStartUtcMs = performance.timeOrigin + performance.now();
        const child: ChildProcess = childProcess.spawn(command, args, spawnOpts);
        const managedChild = registerManagedChild(child, creationWindowStartUtcMs);
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
            releaseManagedChild(managedChild);
        }

        function killChild(force = false): void {
            void terminateManagedChild(managedChild, force);
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
            sinkController.abort();
            killChild();
        }

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }

        if (timeoutMs > 0) {
            timeoutHandle = setTimeout(function () {
                if (settled) return;
                timedOut = true;
                sinkController.abort();
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

        if (!inheritStdio && opts.outputSink) {
            const sink = opts.outputSink;
            const consume = async (stream: 'stdout' | 'stderr'): Promise<void> => {
                const readable = child[stream];
                if (!readable) return;
                const decoder = new StringDecoder('utf8');
                const capture = stream === 'stdout' ? stdoutCapture : stderrCapture;
                const callback = stream === 'stdout' ? opts.onStdout : opts.onStderr;
                try {
                    for await (const chunk of readable) {
                        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        const text = decoder.write(bytes);
                        capture.append(text);
                        callback?.(text);
                        const write = sinkQueue.then(() => {
                            sinkController.signal.throwIfAborted();
                            return sink.write(stream, bytes, sinkController.signal);
                        });
                        sinkQueue = write.catch(() => undefined);
                        await awaitSink(write);
                    }
                    const remainder = decoder.end();
                    capture.append(remainder);
                    if (remainder) callback?.(remainder);
                } catch (error) {
                    sinkError ??= (error instanceof Error ? error.message : String(error)) || 'Output sink failed.';
                    sinkController.abort();
                    killChild();
                }
            };
            sinkReads.push(consume('stdout'), consume('stderr'));
        } else if (!inheritStdio) {
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

        child.once('close', async function (code: number | null) {
            await Promise.all(sinkReads);
            const stdout = stdoutCapture.finish();
            const stderr = stderrCapture.finish();
            settle({
                exitCode: code == null ? 1 : code,
                stdout: stdout.text,
                stderr: stderr.text,
                timedOut,
                cancelled,
                ...(sinkError !== undefined ? { sinkError } : {}),
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
        try {
            assertChildAdmission();
        } catch (error) {
            reject(error);
            return;
        }
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
        const creationWindowStartUtcMs = performance.timeOrigin + performance.now();
        const child: ChildProcess = childProcess.spawn(shellCommand, shellArgs, spawnOptions);
        const managedChild = registerManagedChild(child, creationWindowStartUtcMs);
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
            releaseManagedChild(managedChild);
        }

        function killChild(force = false): void {
            void terminateManagedChild(managedChild, force);
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

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
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
