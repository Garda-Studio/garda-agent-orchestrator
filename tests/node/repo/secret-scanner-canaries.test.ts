import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getRepoRoot } from '../../../scripts/node-foundation/build';

const repoRoot = getRepoRoot();
const scannerInput = process.env.GARDA_GITLEAKS_BIN;
const scannerPath = scannerInput ? path.resolve(repoRoot, scannerInput) : undefined;
const scannerOptions = { skip: scannerPath ? false : 'Set GARDA_GITLEAKS_BIN to run pinned local scanner canaries' };
// Public deterministic fixture data; never an issued credential.
const canary = ['gh', 'p_', createHash('sha256').update('public synthetic Garda T-210 canary').digest('hex').slice(0, 36)].join('');
const positiveFiles = [
    'src/canary.ts', 'scripts/canary.ts', 'src/runtime/canary.ts',
    'scripts/garda-agent-orchestrator/runtime/canary.ts', 'runtime/canary.ts',
    'user/garda-agent-orchestrator/runtime/canary.ts',
    'tests/node/core/redaction.test.ts.backup', 'backup/testResults.xml',
    'src/marked-canary.ts', 'scripts/marked-canary.ts'
];
const dependencyCanaryFile = 'node_modules/pkg/canary.js';
const excludedFiles = [
    'garda-agent-orchestrator/runtime/logs/canary.json',
    'tests/node/core/redaction.test.ts', '.node-build/canary.js',
    dependencyCanaryFile, 'testResults.xml'
];

function writeCanaries(fixtureRoot: string): void {
    for (const file of [...positiveFiles, ...excludedFiles]) {
        const target = path.join(fixtureRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const marker = file === 'src/marked-canary.ts' ? ' // dummy fixture label'
            : file === 'scripts/marked-canary.ts' ? ' // EXAMPLE_TOKEN label' : '';
        fs.writeFileSync(target, `const token = "${canary}";${marker}\n`);
    }
}

function scanCanaries(config: string, mode: 'dir' | 'git'): Set<string> {
    assert.ok(scannerPath, 'An explicitly selected scanner is required');
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-secret-scan-'));
    const fixtureRoot = path.join(tempRoot, 'fixtures');
    try {
        fs.mkdirSync(fixtureRoot);
        writeCanaries(fixtureRoot);
        const configPath = path.join(tempRoot, 'scanner.toml');
        const reportPath = path.join(tempRoot, 'report.json');
        const emptyConfig = path.join(tempRoot, 'empty-git-config');
        const emptyIgnore = path.join(tempRoot, 'empty.gitleaksignore');
        const hooksPath = path.join(tempRoot, 'empty-hooks');
        fs.writeFileSync(configPath, config);
        fs.writeFileSync(emptyConfig, '');
        fs.writeFileSync(emptyIgnore, '');
        fs.mkdirSync(hooksPath);
        const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
        const env = { ...inheritedEnv, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
        if (mode === 'git') {
            const git = (args: string[]) => childProcess.execFileSync('git', [
                '-c', `core.hooksPath=${hooksPath}`, '-c', 'commit.gpgsign=false', ...args
            ], { cwd: fixtureRoot, env, encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
            git(['init', '--template=']);
            git(['add', '--', '.']);
            assert.deepEqual(
                git(['ls-files', '-z']).split('\0').filter(Boolean).sort(),
                [...positiveFiles, ...excludedFiles].sort(),
                'Git fixtures must include even the dependency canary'
            );
            git(['-c', 'user.name=Garda Canary', '-c', 'user.email=canary@example.invalid',
                'commit', '-m', 'Public synthetic scanner fixture']);
        }
        const result = childProcess.spawnSync(scannerPath, [
            mode, '.', '--config', configPath, '--redact', '--no-banner', '--no-color',
            '--log-level', 'error', '--exit-code', '1', '--report-format', 'json',
            '--report-path', reportPath, '--gitleaks-ignore-path', emptyIgnore
        ], { cwd: fixtureRoot, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
        assert.equal(result.error, undefined, 'Scanner must execute successfully');
        assert.equal(result.status, 1, 'The selected scanner must detect the positive canaries');
        const report = fs.readFileSync(reportPath, 'utf8');
        assert.ok(![report, result.stdout, result.stderr].some(text => text.includes(canary)), 'Scanner output must be redacted');
        const findings: unknown = JSON.parse(report);
        assert.ok(Array.isArray(findings));
        return new Set(findings.map((finding: { File: string; RuleID: string }) => {
            assert.equal(finding.RuleID, 'github-pat', 'The built-in PAT rule must be active');
            assert.equal(typeof finding.File, 'string');
            const file = path.isAbsolute(finding.File) ? path.relative(fixtureRoot, finding.File) : finding.File;
            return file.replace(/\\/gu, '/').replace(/^\.\//u, '');
        }));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

test('pinned scanner detects source and nested runtime canaries with narrow exceptions', scannerOptions, () => {
    assert.ok(scannerPath);
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/secret-scanning.yml'), 'utf8');
    const pinnedVersion = /GITLEAKS_VERSION:\s*'([^']+)'/u.exec(workflow)?.[1];
    assert.ok(pinnedVersion, 'The workflow must pin its scanner version');
    assert.equal(childProcess.execFileSync(scannerPath, ['version'], { encoding: 'utf8', timeout: 30000 }).trim(), pinnedVersion);
    const config = fs.readFileSync(path.join(repoRoot, '.gitleaks.toml'), 'utf8');
    for (const mode of ['dir', 'git'] as const) {
        assert.deepEqual([...scanCanaries(config, mode)].sort(), [...positiveFiles].sort(), `${mode} must enforce exact path boundaries`);
    }
});

test('default-rule Git control detects project-excluded fixtures and retains its dependency exclusion', scannerOptions, () => {
    const detected = scanCanaries('[extend]\nuseDefault = true\n', 'git');
    const defaultDetectableFiles = [...positiveFiles, ...excludedFiles.filter(file => file !== dependencyCanaryFile)];
    assert.deepEqual([...detected].sort(), defaultDetectableFiles.sort());
});
