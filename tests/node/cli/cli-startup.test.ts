import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

const CLI_PROBE_TIMEOUT_MS = 30_000;
const PROBE_PREFIX = 'GARDA_FAST_PATH_PROBE ';
const cliEntry = require.resolve('../../../src/cli/main');
const sourceRoot = path.resolve(path.dirname(cliEntry), '..');
const repoRoot = path.resolve(__dirname, '../../../..');
const packageVersion = (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;

interface StartupEvidence {
    moduleCount: number;
    gateModuleCount: number;
    commandDispatchLoaded: boolean;
    taskAuditLoaded: boolean;
    cleanupRuntimeLoaded: boolean;
}

function buildProbeScript(argv: string[]): string {
    return [
        "const path = require('node:path');",
        `const sourceRoot = ${JSON.stringify(sourceRoot)};`,
        "process.once('beforeExit', () => {",
        '  const modules = Object.keys(require.cache).filter(file => file.startsWith(sourceRoot + path.sep));',
        "  const gateRoot = path.join(sourceRoot, 'gates') + path.sep;",
        "  const dispatch = path.join(sourceRoot, 'cli', 'commands', 'command-dispatch.js');",
        "  const taskAudit = path.join(sourceRoot, 'gates', 'task-audit', 'task-audit-summary.js');",
        "  const cleanupRuntime = path.join(sourceRoot, 'lifecycle', 'cleanup', 'cleanup-orchestration.js');",
        `  process.stderr.write('\\n' + ${JSON.stringify(PROBE_PREFIX)} + JSON.stringify({`,
        '    moduleCount: modules.length,',
        '    gateModuleCount: modules.filter(file => file.startsWith(gateRoot)).length,',
        '    commandDispatchLoaded: modules.includes(dispatch),',
        '    taskAuditLoaded: modules.includes(taskAudit),',
        '    cleanupRuntimeLoaded: modules.includes(cleanupRuntime)',
        "  }) + '\\n');",
        '});',
        `require(${JSON.stringify(cliEntry)}).runCliMainWithHandling(${JSON.stringify(argv)}, ${JSON.stringify(repoRoot)});`
    ].join('\n');
}

function inspectStartup(argv: string[]): { stdout: string; evidence: StartupEvidence; durationMs: number } {
    const started = performance.now();
    const result = spawnSync(process.execPath, ['-e', buildProbeScript(argv)], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
        timeout: CLI_PROBE_TIMEOUT_MS
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const line = result.stderr.split(/\r?\n/u).find(value => value.startsWith(PROBE_PREFIX));
    assert.ok(line, 'CLI must exit normally and produce actual module-load evidence');
    return {
        stdout: result.stdout,
        evidence: JSON.parse(line.slice(PROBE_PREFIX.length)) as StartupEvidence,
        durationMs: Math.round(performance.now() - started)
    };
}

for (const argv of [['--version'], ['--offline', '--no-color', '-v'], ['--help'], ['--no-color', '-h']]) {
    test(`CLI ${argv.join(' ')} avoids loading validation and command execution`, t => {
        const { stdout, evidence, durationMs } = inspectStartup(argv);
        if (argv.includes('--version') || argv.includes('-v')) {
            assert.equal(stdout.trim(), packageVersion);
        } else {
            assert.match(stdout, /Usage:/u);
            assert.match(stdout, /cleanup uses retention defaults/u);
        }
        assert.equal(evidence.commandDispatchLoaded, false, 'Fast paths must not load command-dispatch');
        assert.equal(evidence.taskAuditLoaded, false, 'Fast paths must not load task audit execution');
        assert.equal(evidence.cleanupRuntimeLoaded, false, 'Fast paths must not load cleanup execution');
        t.diagnostic(`CLI_STARTUP modules=${evidence.moduleCount} gates=${evidence.gateModuleCount} duration_ms=${durationMs}`);
    });
}

test('CLI cold status startup preserves banner and status helper exports', () => {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cold-status-'));
    try {
        const { stdout, evidence } = inspectStartup(['--no-color', 'status', '--target-root', targetRoot]);
        assert.match(stdout, /Workspace status/u);
        assert.match(stdout, /Not installed/u);
        assert.equal(evidence.commandDispatchLoaded, true, 'Ordinary status must execute command-dispatch');
    } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
    }
});
