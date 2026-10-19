'use strict';

const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const bounded = value => String(value || '').slice(0, 8_192);
const emit = (name, value) => console.log(JSON.stringify({ kind: 'windows-native-diagnostic', name, ...value }));
const summarize = result => ({ status: result.status, signal: result.signal,
    error_code: result.error?.code, stdout: bounded(result.stdout), stderr: bounded(result.stderr) });

async function main() {
    if (process.platform !== 'win32') throw new Error('This probe requires native Windows.');
    const temporaryParent = fs.realpathSync.native(os.tmpdir());
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(temporaryParent, 'garda-native-probe-')));
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    const timelinePath = path.join(eventsRoot, 'T-NATIVE-PROBE.jsonl');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.writeFileSync(timelinePath, '{}\n');
    const system32 = path.join(fs.realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot'), 'System32');
    const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const snapshot = require('../../.node-build/src/gate-runtime/timeline/task-timeline-read-snapshot.js');
    const subprocess = require('../../.node-build/src/core/subprocess.js');
    const originalExecFile = cp.execFile;
    const observedInvocations = [];
    let capturedInvocation;
    let timelineAccepted = false;
    let terminationAccepted = false;
    try {
        emit('host', { node: process.version, temporary_parent: temporaryParent,
            system32, SystemRoot: process.env.SystemRoot, fixture: root,
            utc_clock_offset_ms: Date.now() - (performance.timeOrigin + performance.now()) });
        for (const target of [root, eventsRoot, timelinePath]) {
            const args = [target];
            for (const command of ['icacls.exe', path.join(system32, 'icacls.exe')]) {
                const result = cp.spawnSync(command, args, {
                    encoding: 'utf8', timeout: 1_000, maxBuffer: 256 * 1024, windowsHide: true
                });
                emit('acl', { target, command, ...summarize(result),
                    explicit_write_grant: snapshot.windowsAclOutputHasExplicitWriteGrant(String(result.stdout || '')) });
            }
        }
        try {
            timelineAccepted = snapshot.readTaskTimelineTextFile(timelinePath) === '{}\n';
            emit('timeline_guard', { accepted: timelineAccepted });
        } catch (error) {
            emit('timeline_guard', { accepted: false, error: bounded(error.message) });
        }
        // Observe the production invocation without changing its command, options or callback result.
        cp.execFile = function (command, args, options, callback) {
            const started = performance.now();
            capturedInvocation = { command, args, options };
            let completed;
            observedInvocations.push(new Promise(resolve => { completed = resolve; }));
            try {
                return originalExecFile.call(cp, command, args, options, function (error, stdout, stderr) {
                    emit('production_terminator', { command, elapsed_ms: performance.now() - started,
                        timeout_ms: options.timeout, error_code: error?.code, killed: error?.killed,
                        owned_targets: options.env.GARDA_PROCESS_TREE_TARGETS,
                        stdout: bounded(stdout), stderr: bounded(stderr),
                        script_sha256: crypto.createHash('sha256').update(String(args.at(-1))).digest('hex') });
                    try { callback.call(this, error, stdout, stderr); }
                    finally { completed(); }
                });
            } catch (error) {
                completed();
                throw error;
            }
        };
        const started = performance.now();
        const result = await subprocess.spawnStreamed(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { timeoutMs: 500 });
        const elapsed = performance.now() - started;
        await Promise.all(observedInvocations);
        terminationAccepted = result.timedOut && result.exitCode !== 0
            && elapsed <= subprocess.SUBPROCESS_TERMINATION_TIMEOUT_MS + 1_000;
        emit('managed_timeout', { ...result, elapsed_ms: elapsed, accepted: terminationAccepted });
        cp.execFile = originalExecFile;
        if (capturedInvocation) {
            // Empty targets compile the exact native helper but cannot select or terminate any process.
            for (const [environment, env] of [
                ['production-empty-targets', { ...capturedInvocation.options.env, GARDA_PROCESS_TREE_TARGETS: '' }],
                ['inherited-empty-targets', { ...process.env, GARDA_PROCESS_TREE_TARGETS: '' }]
            ]) {
                const before = performance.now();
                const compilation = cp.spawnSync(powershell, capturedInvocation.args, {
                    env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true
                });
                emit('native_helper_compile', { environment, elapsed_ms: performance.now() - before,
                    ...summarize(compilation) });
            }
        }
        emit('summary', { timeline_accepted: timelineAccepted, termination_accepted: terminationAccepted,
            full_release_validation: false });
        if (!timelineAccepted || !terminationAccepted) process.exitCode = 1;
    } finally {
        cp.execFile = originalExecFile;
        const relative = path.relative(temporaryParent, root);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
            || fs.lstatSync(root).isSymbolicLink() || fs.realpathSync.native(root) !== root) {
            throw new Error('Diagnostic fixture cleanup boundary changed.');
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
}

if (process.argv[2] === '--validate-selection') {
    if (process.env.MANUAL_JOB !== 'release' || process.env.MANUAL_OS !== 'windows-latest') {
        console.error('Windows native diagnosis requires job=release and os=windows-latest.');
        process.exitCode = 1;
    }
} else {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
