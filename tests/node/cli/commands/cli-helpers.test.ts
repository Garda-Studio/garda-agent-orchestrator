import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    applyNoColorFlag,
    buildBannerText,
    buildCommandHelpText,
    buildHelpText,
    COMMAND_SUMMARY,
    convertSourceOfTruthToEntrypoint,
    copyPath,
    DEPLOY_ITEMS,
    deployFreshBundle,
    ensureDirectoryExists,
    ensureSourceItemExists,
    extractGlobalFlags,
    getAgentInitPromptPath,
    getBundlePath,
    getInitAnswerValue,
    normalizeActiveAgentFiles,
    normalizeAgentEntrypointToken,
    normalizeAssistantBrevity,
    normalizeLogicalKey,
    normalizePathValue,
    normalizeSourceOfTruth,
    padRight,
    parseBooleanText,
    parseOptionalText,
    parseOptions,
    parseRequiredText,
    isBooleanText,
    readBundleVersion,
    readOptionalJsonFile,
    removePathIfExists,
    resolvePathInsideRoot,
    resolveWorkspaceDisplayVersion,
    shouldSkipPath,
    supportsColor,
    syncBundleItems,
    toPosixPath,
    tryNormalizeAssistantBrevity,
    tryNormalizeSourceOfTruth,
    tryParseBooleanText
} from '../../../../src/cli/commands/cli-helpers';
import { dispatchCliCommand } from '../../../../src/cli/commands/command-dispatch';
import { handleUninstall } from '../../../../src/cli/commands/workspace/workspace-maintenance-command';
import { DEFAULT_SOURCE_OF_TRUTH } from '../../../../src/core/constants';
import { buildDefaultRetentionPolicy, RETENTION_POLICY_DEFAULTS } from '../../../../src/lifecycle/cleanup';
import { MANAGED_END, MANAGED_START } from '../../../../src/materialization/content-builders';

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function captureConsoleOutput(action: () => void): string {
    const captured: string[] = [];
    const originalLog = console.log;
    try {
        console.log = (...args: unknown[]): void => {
            captured.push(args.map((arg) => String(arg)).join(' '));
        };
        action();
    } finally {
        console.log = originalLog;
    }
    return stripAnsi(captured.join('\n'));
}

test('parseOptions parses string flags', () => {
    const defs = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--branch': { key: 'branch', type: 'string' }
    };
    const { options } = parseOptions(['--target-root', '/tmp', '--branch', 'main'], defs);
    assert.equal(options.targetRoot, '/tmp');
    assert.equal(options.branch, 'main');
});

test('parseOptions parses boolean flags', () => {
    const defs = {
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--no-prompt': { key: 'noPrompt', type: 'boolean' }
    };
    const { options } = parseOptions(['--dry-run', '--no-prompt'], defs);
    assert.equal(options.dryRun, true);
    assert.equal(options.noPrompt, true);
});

test('parseOptions parses inline equals values', () => {
    const defs = { '--target-root': { key: 'targetRoot', type: 'string' } };
    const { options } = parseOptions(['--target-root=/tmp/test'], defs);
    assert.equal(options.targetRoot, '/tmp/test');
});

test('parseOptions accumulates repeated string-array flags', () => {
    const defs = { '--changed-path': { key: 'changedPaths', type: 'string[]' } };
    const { options } = parseOptions(['--changed-path', 'src/app.ts', '--changed-path=tests/app.test.ts'], defs);
    assert.deepEqual(options.changedPaths, ['src/app.ts', 'tests/app.test.ts']);
});

test('parseOptions recognizes --help and --version', () => {
    const { options } = parseOptions(['-h', '-v'], {});
    assert.equal(options.help, true);
    assert.equal(options.version, true);
});

test('parseOptions allows positionals when configured', () => {
    const defs = {};
    const { positionals } = parseOptions(['mypath'], defs, { allowPositionals: true, maxPositionals: 1 });
    assert.deepEqual(positionals, ['mypath']);
});

test('parseOptions rejects unknown options', () => {
    assert.throws(
        () => parseOptions(['--unknown'], {}),
        /Unknown option/
    );
});

test('parseOptions rejects excess positionals', () => {
    assert.throws(
        () => parseOptions(['a', 'b'], {}, { allowPositionals: true, maxPositionals: 1 }),
        /Too many positional/
    );
});

test('parseOptions rejects unexpected positionals', () => {
    assert.throws(
        () => parseOptions(['a'], {}),
        /Unexpected positional/
    );
});

test('parseOptions throws when string flag missing value', () => {
    const defs = { '--target-root': { key: 'targetRoot', type: 'string' } };
    assert.throws(
        () => parseOptions(['--target-root'], defs),
        /requires a value/
    );
});

test('parseOptions consumes space-separated false for boolean flags', () => {
    const defs = {
        '--behavior-changed': { key: 'behaviorChanged', type: 'boolean' },
        '--rationale': { key: 'rationale', type: 'string' }
    };
    const { options } = parseOptions(['--behavior-changed', 'false', '--rationale', 'none'], defs);
    assert.equal(options.behaviorChanged, false);
    assert.equal(options.rationale, 'none');
});

test('parseOptions consumes space-separated true for boolean flags', () => {
    const defs = {
        '--sensitive-scope-reviewed': { key: 'sensitiveReviewed', type: 'boolean' }
    };
    const { options } = parseOptions(['--sensitive-scope-reviewed', 'true'], defs);
    assert.equal(options.sensitiveReviewed, true);
});

test('parseOptions handles mixed boolean forms in a single invocation', () => {
    const defs = {
        '--behavior-changed': { key: 'behaviorChanged', type: 'boolean' },
        '--changelog-updated': { key: 'changelogUpdated', type: 'boolean' },
        '--sensitive-scope-reviewed': { key: 'sensitiveReviewed', type: 'boolean' },
        '--rationale': { key: 'rationale', type: 'string' }
    };
    const { options } = parseOptions([
        '--behavior-changed', 'false',
        '--changelog-updated=false',
        '--sensitive-scope-reviewed', 'true',
        '--rationale', 'test'
    ], defs);
    assert.equal(options.behaviorChanged, false);
    assert.equal(options.changelogUpdated, false);
    assert.equal(options.sensitiveReviewed, true);
    assert.equal(options.rationale, 'test');
});

test('parseOptions bare boolean flag defaults to true when next arg is another flag', () => {
    const defs = {
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--no-prompt': { key: 'noPrompt', type: 'boolean' }
    };
    const { options } = parseOptions(['--dry-run', '--no-prompt'], defs);
    assert.equal(options.dryRun, true);
    assert.equal(options.noPrompt, true);
});

test('parseOptions bare boolean flag defaults to true at end of args', () => {
    const defs = { '--dry-run': { key: 'dryRun', type: 'boolean' } };
    const { options } = parseOptions(['--dry-run'], defs);
    assert.equal(options.dryRun, true);
});

test('parseOptions does not consume non-boolean tokens as boolean values', () => {
    const defs = {
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--target-root': { key: 'targetRoot', type: 'string' }
    };
    const { options } = parseOptions(['--dry-run', '--target-root', '/workspace'], defs);
    assert.equal(options.dryRun, true);
    assert.equal(options.targetRoot, '/workspace');
});

test('parseOptions consumes all canonical boolean literals via space', () => {
    const defs = { '--flag': { key: 'flag', type: 'boolean' } };
    for (const val of ['true', 'yes', 'y', '1', 'on', 'да']) {
        assert.equal(parseOptions(['--flag', val], defs).options.flag, true, `--flag ${val}`);
    }
    for (const val of ['false', 'no', 'n', '0', 'off', 'нет']) {
        assert.equal(parseOptions(['--flag', val], defs).options.flag, false, `--flag ${val}`);
    }
});

test('parseOptions rejects positional after boolean flag when non-boolean text follows', () => {
    const defs = { '--flag': { key: 'flag', type: 'boolean' } };
    assert.throws(
        () => parseOptions(['--flag', 'notaboolean'], defs),
        /Unexpected positional/
    );
});

test('isBooleanText recognizes canonical true/false literals', () => {
    for (const val of ['true', 'false', 'yes', 'no', 'y', 'n', '1', '0', 'on', 'off', 'да', 'нет']) {
        assert.equal(isBooleanText(val), true, `expected isBooleanText('${val}') to be true`);
    }
});

test('isBooleanText is case-insensitive', () => {
    assert.equal(isBooleanText('TRUE'), true);
    assert.equal(isBooleanText('False'), true);
    assert.equal(isBooleanText('YES'), true);
});

test('isBooleanText rejects non-boolean text', () => {
    assert.equal(isBooleanText('maybe'), false);
    assert.equal(isBooleanText(''), false);
    assert.equal(isBooleanText('hello'), false);
});

test('parseBooleanText handles true values', () => {
    assert.equal(parseBooleanText(true, 'test'), true);
    assert.equal(parseBooleanText('true', 'test'), true);
    assert.equal(parseBooleanText('yes', 'test'), true);
    assert.equal(parseBooleanText('1', 'test'), true);
    assert.equal(parseBooleanText('да', 'test'), true);
    assert.equal(parseBooleanText(1, 'test'), true);
});

test('parseBooleanText handles false values', () => {
    assert.equal(parseBooleanText(false, 'test'), false);
    assert.equal(parseBooleanText('false', 'test'), false);
    assert.equal(parseBooleanText('no', 'test'), false);
    assert.equal(parseBooleanText('0', 'test'), false);
    assert.equal(parseBooleanText('нет', 'test'), false);
    assert.equal(parseBooleanText(0, 'test'), false);
});

test('parseBooleanText throws for invalid input', () => {
    assert.throws(() => parseBooleanText('maybe', 'test'), /must be one of/);
});

test('tryParseBooleanText returns fallback for null/undefined', () => {
    assert.equal(tryParseBooleanText(null, true), true);
    assert.equal(tryParseBooleanText(undefined, false), false);
    assert.equal(tryParseBooleanText('', true), true);
});

test('tryParseBooleanText parses valid values', () => {
    assert.equal(tryParseBooleanText('yes', false), true);
    assert.equal(tryParseBooleanText('no', true), false);
});

test('tryParseBooleanText returns fallback for invalid', () => {
    assert.equal(tryParseBooleanText('maybe', true), true);
});

test('normalizeSourceOfTruth normalizes case-insensitive values', () => {
    assert.equal(normalizeSourceOfTruth('claude'), 'Claude');
    assert.equal(normalizeSourceOfTruth('CODEX'), 'Codex');
    assert.equal(normalizeSourceOfTruth('cursor'), 'Cursor');
    assert.equal(normalizeSourceOfTruth('qwen'), 'Qwen');
    assert.equal(normalizeSourceOfTruth('GitHubCopilot'), 'GitHubCopilot');
    assert.equal(normalizeSourceOfTruth('github-copilot-cli'), 'GitHubCopilot');
});

test('normalizeSourceOfTruth throws for invalid values', () => {
    assert.throws(() => normalizeSourceOfTruth('Other'), /must be one of/);
});

test('tryNormalizeSourceOfTruth returns fallback for empty', () => {
    assert.equal(tryNormalizeSourceOfTruth(null, 'Claude'), 'Claude');
    assert.equal(tryNormalizeSourceOfTruth('', 'Claude'), 'Claude');
    assert.equal(tryNormalizeSourceOfTruth(undefined), 'Codex');
    assert.equal(DEFAULT_SOURCE_OF_TRUTH, 'Codex');
});

test('tryNormalizeSourceOfTruth returns fallback for invalid', () => {
    assert.equal(tryNormalizeSourceOfTruth('Invalid', 'Codex'), 'Codex');
});

test('normalizeAssistantBrevity normalizes valid values', () => {
    assert.equal(normalizeAssistantBrevity('concise'), 'concise');
    assert.equal(normalizeAssistantBrevity('Detailed'), 'detailed');
});

test('normalizeAssistantBrevity throws for invalid values', () => {
    assert.throws(() => normalizeAssistantBrevity('verbose'), /must be one of/);
});

test('tryNormalizeAssistantBrevity returns fallback for empty/invalid', () => {
    assert.equal(tryNormalizeAssistantBrevity(null), 'concise');
    assert.equal(tryNormalizeAssistantBrevity('invalid', 'detailed'), 'detailed');
});

test('normalizeAgentEntrypointToken maps shorthand names', () => {
    assert.equal(normalizeAgentEntrypointToken('claude'), 'CLAUDE.md');
    assert.equal(normalizeAgentEntrypointToken('codex'), 'AGENTS.md');
    assert.equal(normalizeAgentEntrypointToken('cursor'), 'AGENTS.md');
    assert.equal(normalizeAgentEntrypointToken('gemini'), 'GEMINI.md');
    assert.equal(normalizeAgentEntrypointToken('qwen'), 'QWEN.md');
    assert.equal(normalizeAgentEntrypointToken('qwen.md'), 'QWEN.md');
    assert.equal(normalizeAgentEntrypointToken('githubcopilot'), '.github/copilot-instructions.md');
    assert.equal(normalizeAgentEntrypointToken('copilot'), '.github/copilot-instructions.md');
    assert.equal(normalizeAgentEntrypointToken('github-copilot-cli'), '.github/copilot-instructions.md');
    assert.equal(normalizeAgentEntrypointToken('windsurf'), '.windsurf/rules/rules.md');
    assert.equal(normalizeAgentEntrypointToken('junie'), '.junie/guidelines.md');
    assert.equal(normalizeAgentEntrypointToken('antigravity'), '.antigravity/rules.md');
});

test('normalizeAgentEntrypointToken returns null for empty', () => {
    assert.equal(normalizeAgentEntrypointToken(''), null);
    assert.equal(normalizeAgentEntrypointToken(null), null);
});

test('normalizeAgentEntrypointToken strips "or" prefix', () => {
    assert.equal(normalizeAgentEntrypointToken('or CLAUDE.md'), 'CLAUDE.md');
});

test('normalizeAgentEntrypointToken resolves numbered selections', () => {
    assert.equal(normalizeAgentEntrypointToken('1'), 'CLAUDE.md');
    assert.equal(normalizeAgentEntrypointToken('2'), 'AGENTS.md');
    assert.equal(normalizeAgentEntrypointToken('4'), 'QWEN.md');
    assert.equal(normalizeAgentEntrypointToken('8'), '.antigravity/rules.md');
});

test('normalizeAgentEntrypointToken returns null for unknown', () => {
    assert.equal(normalizeAgentEntrypointToken('unknown.md'), null);
    assert.equal(normalizeAgentEntrypointToken('99'), null);
});

test('convertSourceOfTruthToEntrypoint maps known values', () => {
    assert.equal(convertSourceOfTruthToEntrypoint('Claude'), 'CLAUDE.md');
    assert.equal(convertSourceOfTruthToEntrypoint('Codex'), 'AGENTS.md');
    assert.equal(convertSourceOfTruthToEntrypoint('Cursor'), 'AGENTS.md');
    assert.equal(convertSourceOfTruthToEntrypoint('Qwen'), 'QWEN.md');
    assert.equal(convertSourceOfTruthToEntrypoint('GitHubCopilot'), '.github/copilot-instructions.md');
});

test('convertSourceOfTruthToEntrypoint returns null for unknown', () => {
    assert.equal(convertSourceOfTruthToEntrypoint('Unknown'), null);
    assert.equal(convertSourceOfTruthToEntrypoint(''), null);
});

test('normalizeActiveAgentFiles includes canonical entrypoint for source', () => {
    const result = normalizeActiveAgentFiles(null, 'Claude');
    assert.ok(result!.includes('CLAUDE.md'));
});

test('normalizeActiveAgentFiles merges comma-separated inputs with canonical', () => {
    const result = normalizeActiveAgentFiles('AGENTS.md, GEMINI.md', 'Claude');
    assert.ok(result!.includes('CLAUDE.md'));
    assert.ok(result!.includes('AGENTS.md'));
    assert.ok(result!.includes('GEMINI.md'));
});

test('normalizeActiveAgentFiles supports numbered selections in non-interactive setup input', () => {
    const result = normalizeActiveAgentFiles('1, 2, 4, 8', 'Claude');
    assert.equal(result, 'CLAUDE.md, AGENTS.md, QWEN.md, .antigravity/rules.md');
});

test('normalizeActiveAgentFiles returns null for empty input and unknown source', () => {
    assert.equal(normalizeActiveAgentFiles(null, 'Unknown'), null);
});

test('normalizeLogicalKey strips separators and lowercases', () => {
    assert.equal(normalizeLogicalKey('Assistant_Language'), 'assistantlanguage');
    assert.equal(normalizeLogicalKey('enforce-no-auto-commit'), 'enforcenoautocommit');
});

test('getInitAnswerValue finds case-insensitive keys', () => {
    const answers = { AssistantLanguage: 'English', SourceOfTruth: 'Claude' };
    assert.equal(getInitAnswerValue(answers, 'assistantlanguage'), 'English');
    assert.equal(getInitAnswerValue(answers, 'source_of_truth'), 'Claude');
    assert.equal(getInitAnswerValue(answers, 'missing'), null);
});

test('parseOptionalText handles null/undefined/empty', () => {
    assert.equal(parseOptionalText(null), null);
    assert.equal(parseOptionalText(undefined), null);
    assert.equal(parseOptionalText(''), null);
    assert.equal(parseOptionalText('hello'), 'hello');
});

test('parseOptionalText joins arrays', () => {
    assert.equal(parseOptionalText(['a', 'b']), 'a, b');
    assert.equal(parseOptionalText([]), null);
});

test('parseRequiredText throws for empty', () => {
    assert.throws(() => parseRequiredText('', 'field'), /must not be empty/);
    assert.throws(() => parseRequiredText(null, 'field'), /must not be empty/);
});

test('parseRequiredText returns trimmed text', () => {
    assert.equal(parseRequiredText('  hello  ', 'field'), 'hello');
});

test('padRight pads to minimum width', () => {
    assert.equal(padRight('hi', 5), 'hi   ');
    assert.equal(padRight('hello', 3), 'hello');
});

test('toPosixPath converts backslashes', () => {
    assert.equal(toPosixPath('a\\b\\c'), 'a/b/c');
    assert.equal(toPosixPath('a/b/c'), 'a/b/c');
});

test('normalizePathValue resolves to absolute', () => {
    const result = normalizePathValue('.');
    assert.ok(path.isAbsolute(result));
});

test('shouldSkipPath detects skipped entries', () => {
    assert.equal(shouldSkipPath('/some/path/__pycache__'), true);
    assert.equal(shouldSkipPath('/some/path/.pytest_cache'), true);
    assert.equal(shouldSkipPath('/some/path/file.pyc'), true);
    assert.equal(shouldSkipPath('/some/path/file.pyo'), true);
    assert.equal(shouldSkipPath('/some/path/file.ts'), false);
    assert.equal(shouldSkipPath('/some/path/normal'), false);
});

test('removePathIfExists is no-op for missing path', () => {
    removePathIfExists(path.join(os.tmpdir(), 'nonexistent-' + Date.now()));
});

test('copyPath copies file correctly', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-test-'));
    try {
        const srcFile = path.join(tmpDir, 'source.txt');
        const dstFile = path.join(tmpDir, 'sub', 'dest.txt');
        fs.writeFileSync(srcFile, 'hello', 'utf8');
        copyPath(srcFile, dstFile);
        assert.equal(fs.readFileSync(dstFile, 'utf8'), 'hello');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('copyPath copies directory recursively', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-test-'));
    try {
        const srcDir = path.join(tmpDir, 'src');
        const dstDir = path.join(tmpDir, 'dst');
        fs.mkdirSync(path.join(srcDir, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(srcDir, 'a.txt'), 'aa', 'utf8');
        fs.writeFileSync(path.join(srcDir, 'sub', 'b.txt'), 'bb', 'utf8');
        copyPath(srcDir, dstDir);
        assert.equal(fs.readFileSync(path.join(dstDir, 'a.txt'), 'utf8'), 'aa');
        assert.equal(fs.readFileSync(path.join(dstDir, 'sub', 'b.txt'), 'utf8'), 'bb');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('copyPath skips __pycache__', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-test-'));
    try {
        const srcDir = path.join(tmpDir, '__pycache__');
        const dstDir = path.join(tmpDir, 'dst');
        fs.mkdirSync(srcDir);
        fs.writeFileSync(path.join(srcDir, 'file.pyc'), 'data', 'utf8');
        copyPath(srcDir, dstDir);
        assert.equal(fs.existsSync(dstDir), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('copyPath rejects symlink targets outside the bundle root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-test-'));
    try {
        const sourceRoot = path.join(tmpDir, 'source');
        const destRoot = path.join(tmpDir, 'dest');
        const outsideFile = path.join(tmpDir, 'outside.txt');
        const linkPath = path.join(sourceRoot, 'outside-link.txt');

        fs.mkdirSync(sourceRoot, { recursive: true });
        fs.writeFileSync(outsideFile, 'outside', 'utf8');

        try {
            fs.symlinkSync(outsideFile, linkPath);
        } catch (error: unknown) {
            if (error && ['EPERM', 'EACCES', 'UNKNOWN'].includes((error as { code?: string }).code as string)) {
                return;
            }
            throw error;
        }

        assert.throws(
            () => copyPath(linkPath, path.join(destRoot, 'outside-link.txt'), sourceRoot),
            /Refusing to copy symlink outside bundle root/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('ensureSourceItemExists throws for missing asset', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-test-'));
    try {
        assert.throws(
            () => ensureSourceItemExists(tmpDir, 'nonexistent'),
            /Bundle source asset is missing/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('ensureSourceItemExists returns path for existing asset', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hi', 'utf8');
        const result = ensureSourceItemExists(tmpDir, 'file.txt');
        assert.equal(result, path.join(tmpDir, 'file.txt'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

function writeCompiledRuntimeFixture(sourceRoot: string): void {
    const runtimeRoot = path.join(sourceRoot, 'dist', 'src');
    fs.mkdirSync(path.join(runtimeRoot, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
    fs.writeFileSync(path.join(runtimeRoot, 'cli', 'main.js'), 'module.exports = {};\n', 'utf8');
}

function writeDevBuildRuntimeFixture(sourceRoot: string): void {
    const runtimeRoot = path.join(sourceRoot, '.node-build', 'src');
    fs.mkdirSync(path.join(runtimeRoot, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'index.js'), 'module.exports = {};\n', 'utf8');
    fs.writeFileSync(path.join(runtimeRoot, 'cli', 'main.js'), 'module.exports = {};\n', 'utf8');
}

function writeDeploySourceFixture(sourceRoot: string): void {
    fs.mkdirSync(sourceRoot, { recursive: true });
    for (const item of DEPLOY_ITEMS) {
        const itemPath = path.join(sourceRoot, item);
        if (item.includes('/') || item === 'bin' || item === 'src' || item === 'template') {
            fs.mkdirSync(itemPath, { recursive: true });
            fs.writeFileSync(path.join(itemPath, 'marker.txt'), item, 'utf8');
        } else {
            fs.mkdirSync(path.dirname(itemPath), { recursive: true });
            fs.writeFileSync(itemPath, item, 'utf8');
        }
    }
    writeCompiledRuntimeFixture(sourceRoot);
}

test('deployFreshBundle copies DEPLOY_ITEMS to destination', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
    try {
        const sourceRoot = path.join(tmpDir, 'source');
        const destPath = path.join(tmpDir, 'bundle');
        writeDeploySourceFixture(sourceRoot);
        writeDevBuildRuntimeFixture(sourceRoot);
        deployFreshBundle(sourceRoot, destPath);
        assert.ok(fs.existsSync(destPath));
        for (const item of DEPLOY_ITEMS) {
            assert.ok(fs.existsSync(path.join(destPath, item)), `Missing: ${item}`);
        }
        assert.ok(fs.existsSync(path.join(destPath, 'dist', 'src', 'index.js')), 'Missing compiled runtime output');
        assert.ok(!fs.existsSync(path.join(destPath, '.node-build')), 'Deployed bundle must not include .node-build');
        assert.ok(!fs.existsSync(path.join(destPath, 'src')), 'Compiled-only bundle must not synthesize a source tree');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('deployFreshBundle copies the optional source tree when present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
    try {
        const sourceRoot = path.join(tmpDir, 'source');
        const destPath = path.join(tmpDir, 'bundle');
        writeDeploySourceFixture(sourceRoot);
        fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, 'src', 'marker.ts'), 'export {};\n', 'utf8');

        deployFreshBundle(sourceRoot, destPath);

        assert.equal(fs.readFileSync(path.join(destPath, 'src', 'marker.ts'), 'utf8'), 'export {};\n');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('deployFreshBundle throws for non-empty destination', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
    try {
        const dest = path.join(tmpDir, 'dest');
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'existing.txt'), 'data', 'utf8');
        assert.throws(
            () => deployFreshBundle(tmpDir, dest),
            /already exists and is not empty/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('deployFreshBundle allows empty existing directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
    try {
        const sourceRoot = path.join(tmpDir, 'source');
        const destPath = path.join(tmpDir, 'empty-dest');
        writeDeploySourceFixture(sourceRoot);
        fs.mkdirSync(destPath, { recursive: true });
        deployFreshBundle(sourceRoot, destPath);
        assert.ok(fs.existsSync(destPath));
        assert.ok(fs.existsSync(path.join(destPath, 'dist', 'src', 'index.js')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('deployFreshBundle throws when compiled runtime output is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
    try {
        const sourceRoot = path.join(tmpDir, 'source');
        const destPath = path.join(tmpDir, 'bundle');
        fs.mkdirSync(sourceRoot, { recursive: true });
        for (const item of DEPLOY_ITEMS) {
            const itemPath = path.join(sourceRoot, item);
            if (item.includes('/') || item === 'bin' || item === 'src' || item === 'template') {
                fs.mkdirSync(itemPath, { recursive: true });
                fs.writeFileSync(path.join(itemPath, 'marker.txt'), item, 'utf8');
            } else {
                fs.mkdirSync(path.dirname(itemPath), { recursive: true });
                fs.writeFileSync(itemPath, item, 'utf8');
            }
        }
        assert.throws(
            () => deployFreshBundle(sourceRoot, destPath),
            /Garda runtime build output not found/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('syncBundleItems replaces existing items', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
    try {
        const sourceRoot = path.join(tmpDir, 'source');
        const destPath = path.join(tmpDir, 'bundle');
        writeDeploySourceFixture(sourceRoot);
        fs.mkdirSync(destPath, { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, 'VERSION'), 'new-VERSION', 'utf8');
        fs.writeFileSync(path.join(destPath, 'VERSION'), 'old', 'utf8');
        fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, 'src', 'marker.ts'), 'new-source\n', 'utf8');
        fs.mkdirSync(path.join(destPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(destPath, 'src', 'marker.ts'), 'stale-source\n', 'utf8');
        writeDevBuildRuntimeFixture(sourceRoot);
        fs.mkdirSync(path.join(destPath, '.node-build', 'src'), { recursive: true });
        fs.writeFileSync(path.join(destPath, '.node-build', 'src', 'index.js'), 'module.exports = {};\n', 'utf8');

        syncBundleItems(sourceRoot, destPath);
        assert.equal(fs.readFileSync(path.join(destPath, 'VERSION'), 'utf8'), 'new-VERSION');
        assert.ok(fs.existsSync(path.join(destPath, 'dist', 'src', 'index.js')));
        assert.ok(!fs.existsSync(path.join(destPath, '.node-build')), 'Bundle sync must remove stale deployed .node-build');
        assert.equal(fs.readFileSync(path.join(destPath, 'src', 'marker.ts'), 'utf8'), 'new-source\n');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('syncBundleItems removes a stale source tree from a compiled-only bundle', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
    try {
        const sourceRoot = path.join(tmpDir, 'source');
        const destPath = path.join(tmpDir, 'bundle');
        writeDeploySourceFixture(sourceRoot);
        fs.mkdirSync(path.join(destPath, 'src'), { recursive: true });
        fs.writeFileSync(path.join(destPath, 'src', 'stale.ts'), 'stale\n', 'utf8');

        syncBundleItems(sourceRoot, destPath);

        assert.ok(!fs.existsSync(path.join(destPath, 'src')), 'Bundle sync must remove stale optional source');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resolvePathInsideRoot resolves relative path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-test-'));
    try {
        const resolved = resolvePathInsideRoot(tmpDir, 'subdir/file.json', 'TestPath', { allowMissing: true });
        assert.ok(resolved.includes('subdir'));
        assert.ok(resolved.includes('file.json'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('resolvePathInsideRoot throws for path escape', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-test-'));
    try {
        assert.throws(
            () => resolvePathInsideRoot(tmpDir, '../../etc/passwd', 'TestPath'),
            /must resolve inside target root/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('replaced resolvePathInsideRoot rejects a directory symlink or junction escape', (t) => {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-link-root-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-link-outside-'));
    try {
        const linkPath = path.join(targetRoot, 'linked');
        try {
            fs.symlinkSync(
                outsideRoot,
                linkPath,
                process.platform === 'win32' ? 'junction' : 'dir'
            );
        } catch (error: unknown) {
            const code = String((error as NodeJS.ErrnoException)?.code || '');
            if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code)) {
                t.skip(`filesystem links unavailable: ${code}`);
                return;
            }
            throw error;
        }

        assert.throws(
            () => resolvePathInsideRoot(
                targetRoot,
                path.join('linked', 'answers.json'),
                'AnswersPath',
                { allowMissing: true }
            ),
            /without symlink or junction escapes/u
        );
    } finally {
        fs.rmSync(targetRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('resolvePathInsideRoot throws for empty path', () => {
    assert.throws(
        () => resolvePathInsideRoot('/tmp', '', 'TestPath'),
        /must not be empty/
    );
});

test('ensureDirectoryExists throws for missing directory', () => {
    assert.throws(
        () => ensureDirectoryExists(path.join(os.tmpdir(), 'nonexistent-' + Date.now()), 'TestDir'),
        /not found/
    );
});

test('ensureDirectoryExists passes for real directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-test-'));
    try {
        ensureDirectoryExists(tmpDir, 'TestDir');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('getBundlePath joins with default bundle name', () => {
    const result = getBundlePath('/workspace');
    assert.ok(result.endsWith('garda-agent-orchestrator'));
});

test('getAgentInitPromptPath points to AGENT_INIT_PROMPT.md', () => {
    const result = getAgentInitPromptPath('/workspace/garda-agent-orchestrator');
    assert.ok(result.endsWith('AGENT_INIT_PROMPT.md'));
});

test('readOptionalJsonFile returns null for missing file', () => {
    assert.equal(readOptionalJsonFile(path.join(os.tmpdir(), 'missing-' + Date.now() + '.json')), null);
});

test('readOptionalJsonFile returns parsed JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-test-'));
    try {
        const filePath = path.join(tmpDir, 'test.json');
        fs.writeFileSync(filePath, '{"key":"value"}', 'utf8');
        const result = readOptionalJsonFile(filePath);
        assert.deepEqual(result, { key: 'value' });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('readOptionalJsonFile returns null for invalid JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-test-'));
    try {
        const filePath = path.join(tmpDir, 'bad.json');
        fs.writeFileSync(filePath, 'not json', 'utf8');
        assert.equal(readOptionalJsonFile(filePath), null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('readOptionalJsonFile returns null for empty file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-test-'));
    try {
        const filePath = path.join(tmpDir, 'empty.json');
        fs.writeFileSync(filePath, '  ', 'utf8');
        assert.equal(readOptionalJsonFile(filePath), null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('readBundleVersion reads VERSION file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '1.2.3\n', 'utf8');
        assert.equal(readBundleVersion(tmpDir), '1.2.3');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('readBundleVersion falls back to package.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"version":"2.0.0"}', 'utf8');
        assert.equal(readBundleVersion(tmpDir), '2.0.0');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildBannerText includes version and title', () => {
    const pkg = { name: 'test', version: '1.0.8' };
    const text = buildBannerText(pkg, 'Test title', 'Test subtitle');
    assert.ok(text.includes('v1.0.8'));
    assert.ok(text.includes('GARDA AGENT ORCHESTRATOR'));
    assert.ok(text.includes('Test title'));
    assert.ok(text.includes('Test subtitle'));
});

test('buildBannerText supports explicit version override and hiding launcher version', () => {
    const pkg = { name: 'test', version: '1.0.8' };
    const overridden = buildBannerText(pkg, 'Test title', 'Test subtitle', { versionOverride: '2.4.0' });
    assert.ok(overridden.includes('v2.4.0'));
    assert.ok(!overridden.includes('v1.0.8'));

    const hidden = buildBannerText(pkg, 'Test title', 'Test subtitle', { versionOverride: null });
    assert.ok(!hidden.includes('v1.0.8'));
});

test('resolveWorkspaceDisplayVersion prefers deployed bundle version and falls back to root version', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-version-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'garda-agent-orchestrator', 'VERSION'), '2.4.0', 'utf8');
        fs.writeFileSync(path.join(tmpDir, 'VERSION'), '2.3.9', 'utf8');
        assert.equal(resolveWorkspaceDisplayVersion(tmpDir, '1.0.0'), '2.4.0');

        fs.rmSync(path.join(tmpDir, 'garda-agent-orchestrator', 'VERSION'));
        assert.equal(resolveWorkspaceDisplayVersion(tmpDir, '1.0.0'), '2.3.9');

        fs.rmSync(path.join(tmpDir, 'VERSION'));
        assert.equal(resolveWorkspaceDisplayVersion(tmpDir, '1.0.0'), '1.0.0');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildHelpText includes all command descriptions', () => {
    const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
    const text = buildHelpText(pkg);
    assert.ok(text.includes('setup'));
    assert.ok(text.includes('agent-init'));
    assert.ok(text.includes('bootstrap'));
    assert.ok(text.includes('doctor'));
    assert.ok(text.includes('task'));
    assert.ok(text.includes('skills'));
    assert.ok(text.includes('review-capabilities'));
    assert.ok(text.includes('review-catalog'));
    assert.match(text, /repair\s+.*task-event suffixes/u);
    assert.ok(text.includes('workflow'));
    assert.ok(text.includes('suggest'));
    assert.ok(text.includes('--help'));
    assert.ok(text.includes('--version'));
    assert.ok(text.includes('--target-root'));
    assert.ok(text.includes('--repo-url'));
    assert.ok(text.includes('--package-spec'));
    assert.ok(text.includes('--source-path'));
    assert.ok(text.includes('--snapshot-path'));
    assert.ok(text.includes('rollback'));
    assert.ok(text.includes('preserve TASK.md by default'));
    assert.ok(text.includes('--keep-task-file no'));
    assert.ok(text.includes('help <command>'));
    assert.ok(text.includes('gate help <gate-name>'));
});

test('buildCommandHelpText renders command-specific stats help', () => {
    const text = stripAnsi(buildCommandHelpText('stats'));
    assert.ok(text.includes('GARDA_COMMAND_HELP'));
    assert.ok(text.includes('stats'));
    assert.ok(text.includes('--task-id "<task-id>"'));
    assert.ok(text.includes('garda stats --json'));
});

test('buildCommandHelpText explains uninstall task-file preservation and recovery policy', () => {
    const text = stripAnsi(buildCommandHelpText('uninstall'));
    assert.ok(text.includes('TASK.md is preserved by default, including in --no-prompt mode.'));
    assert.ok(text.includes('--keep-task-file no is the explicit destructive override'));
    assert.ok(text.includes('TaskFileRecoveryPath for the exact pre-removal copy'));
    assert.ok(text.includes('without a recovery copy'));
});

test('handleUninstall formats explicit TASK.md removal recovery and no-backup warnings', () => {
    const packageJson = { version: '1.0.8', name: 'garda-agent-orchestrator' };
    for (const skipBackups of [false, true]) {
        const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-uninstall-cli-output-'));
        const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
        const taskPath = path.join(targetRoot, 'TASK.md');
        try {
            fs.mkdirSync(bundleRoot, { recursive: true });
            fs.writeFileSync(
                taskPath,
                `${MANAGED_START}\n# Managed operator queue\n${MANAGED_END}\n`,
                'utf8'
            );
            const argv = [
                '--target-root', targetRoot,
                '--no-prompt',
                '--keep-primary-entrypoint', 'no',
                '--keep-task-file', 'no',
                '--keep-runtime-artifacts', 'no'
            ];
            if (skipBackups) argv.push('--skip-backups');

            const text = captureConsoleOutput(() => handleUninstall(argv, packageJson));
            assert.ok(text.includes('TaskFileDecision: REMOVE_EXPLICIT'));
            if (skipBackups) {
                assert.ok(text.includes('TaskFileRecoveryPath: <none>'));
                assert.ok(text.includes('No backup files were created during uninstall.'));
                assert.ok(text.includes('without a recovery copy'));
            } else {
                assert.match(
                    text,
                    /TaskFileRecoveryPath: .*garda-agent-orchestrator-uninstall-backups.*TASK\.md/
                );
                assert.ok(text.includes('Explicit TASK.md removal completed. Recovery copy:'));
                assert.ok(text.includes('Backup files were created.'));
            }
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    }
});

test('buildCommandHelpText explains agent-init confirmation flags without changing tokens', () => {
    const text = stripAnsi(buildCommandHelpText('agent-init'));
    assert.ok(text.includes('default or custom'));
    assert.ok(text.includes('--ordinary-doc-paths'));
    assert.ok(text.includes('--skills-prompted true'));
    assert.ok(text.includes('question was shown'));
    assert.ok(text.includes('user declined extra skills'));
    assert.ok(text.includes('--skills-prompted false'));
    assert.ok(text.includes('auditable planning/status/changelog/product doc routing hints'));
    assert.ok(text.includes('not a global ignore list or a way to hide files'));
    assert.ok(text.includes('not a global ignore list'));
});

test('COMMAND_SUMMARY has expected commands', () => {
    const names = COMMAND_SUMMARY.map((command) => command[0]);
    assert.ok(names.includes('setup'));
    assert.ok(names.includes('agent-init'));
    assert.ok(names.includes('next-step'));
    assert.ok(names.includes('bootstrap'));
    assert.ok(names.includes('doctor'));
    assert.ok(names.includes('status'));
    assert.ok(names.includes('task'));
    assert.ok(names.includes('rollback'));
    assert.ok(names.includes('skills'));
    assert.ok(names.includes('review-capabilities'));
    assert.ok(names.includes('review-catalog'));
    assert.ok(names.includes('workflow'));
    assert.ok(names.includes('gate'));
    assert.equal(COMMAND_SUMMARY.find((command) => command[0] === 'skills')![1], 'List, suggest, and manage optional skill packs');
    assert.equal(
        COMMAND_SUMMARY.find((command) => command[0] === 'review-capabilities')![1],
        'Show, enable, and disable repo-local optional review capabilities'
    );
    assert.equal(
        COMMAND_SUMMARY.find((command) => command[0] === 'review-catalog')![1],
        'Inspect and safely manage review lanes, profiles, and dependencies'
    );
    assert.equal(COMMAND_SUMMARY.find((command) => command[0] === 'workflow')![1], 'Show and set repo-local workflow config');
});

test('extractGlobalFlags extracts --no-color and returns rest', () => {
    const result = extractGlobalFlags(['--no-color', 'status', '--json']);
    assert.equal(result.noColor, true);
    assert.deepEqual(result.rest, ['status', '--json']);
});

test('extractGlobalFlags returns noColor=false when flag absent', () => {
    const result = extractGlobalFlags(['doctor', '--compact']);
    assert.equal(result.noColor, false);
    assert.deepEqual(result.rest, ['doctor', '--compact']);
});

test('extractGlobalFlags handles --no-color at end of argv', () => {
    const result = extractGlobalFlags(['status', '--json', '--no-color']);
    assert.equal(result.noColor, true);
    assert.deepEqual(result.rest, ['status', '--json']);
});

test('extractGlobalFlags handles empty argv', () => {
    const result = extractGlobalFlags([]);
    assert.equal(result.noColor, false);
    assert.deepEqual(result.rest, []);
});

test('extractGlobalFlags handles --no-color only', () => {
    const result = extractGlobalFlags(['--no-color']);
    assert.equal(result.noColor, true);
    assert.deepEqual(result.rest, []);
});

test('extractGlobalFlags extracts --offline flag', () => {
    const result = extractGlobalFlags(['--offline', 'update', '--dry-run']);
    assert.equal(result.offline, true);
    assert.equal(result.forceNetwork, false);
    assert.deepEqual(result.rest, ['update', '--dry-run']);
});

test('extractGlobalFlags extracts --force-network flag', () => {
    const result = extractGlobalFlags(['--offline', '--force-network', 'update']);
    assert.equal(result.offline, true);
    assert.equal(result.forceNetwork, true);
    assert.deepEqual(result.rest, ['update']);
});

test('extractGlobalFlags defaults offline and forceNetwork to false', () => {
    const result = extractGlobalFlags(['status', '--json']);
    assert.equal(result.offline, false);
    assert.equal(result.forceNetwork, false);
});

test('extractGlobalFlags handles --offline at end of argv', () => {
    const result = extractGlobalFlags(['check-update', '--offline']);
    assert.equal(result.offline, true);
    assert.deepEqual(result.rest, ['check-update']);
});

test('extractGlobalFlags does not treat --bundle-name as a supported global flag', () => {
    const result = extractGlobalFlags(['--bundle-name', 'custom-garda', 'status']);
    assert.equal(result.noColor, false);
    assert.equal(result.offline, false);
    assert.equal(result.forceNetwork, false);
    assert.deepEqual(result.rest, ['--bundle-name', 'custom-garda', 'status']);
});

test('public CLI rejects --bundle-name as an unsupported command', () => {
    const cliPath = path.join(process.cwd(), 'bin', 'garda.js');
    const result = childProcess.spawnSync(
        process.execPath,
        [cliPath, '--bundle-name', 'custom-garda', 'status'],
        {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: { ...process.env, NO_COLOR: '1' }
        }
    );

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unsupported command: --bundle-name/);
});

test('applyNoColorFlag sets NO_COLOR when true', () => {
    const saved = process.env.NO_COLOR;
    try {
        delete process.env.NO_COLOR;
        applyNoColorFlag(true);
        assert.equal(process.env.NO_COLOR, '1');
    } finally {
        if (saved === undefined) { delete process.env.NO_COLOR; } else { process.env.NO_COLOR = saved; }
    }
});

test('applyNoColorFlag does not set NO_COLOR when false', () => {
    const saved = process.env.NO_COLOR;
    try {
        delete process.env.NO_COLOR;
        applyNoColorFlag(false);
        assert.equal(process.env.NO_COLOR, undefined);
    } finally {
        if (saved === undefined) { delete process.env.NO_COLOR; } else { process.env.NO_COLOR = saved; }
    }
});

test('supportsColor returns false when NO_COLOR is set', () => {
    const savedNoColor = process.env.NO_COLOR;
    const savedForceColor = process.env.FORCE_COLOR;
    try {
        process.env.NO_COLOR = '1';
        delete process.env.FORCE_COLOR;
        assert.equal(supportsColor(), false);
    } finally {
        if (savedNoColor === undefined) { delete process.env.NO_COLOR; } else { process.env.NO_COLOR = savedNoColor; }
        if (savedForceColor === undefined) { delete process.env.FORCE_COLOR; } else { process.env.FORCE_COLOR = savedForceColor; }
    }
});

test('supportsColor returns false when NO_COLOR is empty string', () => {
    const savedNoColor = process.env.NO_COLOR;
    const savedForceColor = process.env.FORCE_COLOR;
    try {
        process.env.NO_COLOR = '';
        delete process.env.FORCE_COLOR;
        assert.equal(supportsColor(), false);
    } finally {
        if (savedNoColor === undefined) { delete process.env.NO_COLOR; } else { process.env.NO_COLOR = savedNoColor; }
        if (savedForceColor === undefined) { delete process.env.FORCE_COLOR; } else { process.env.FORCE_COLOR = savedForceColor; }
    }
});

test('supportsColor returns true when FORCE_COLOR is set', () => {
    const savedNoColor = process.env.NO_COLOR;
    const savedForceColor = process.env.FORCE_COLOR;
    try {
        delete process.env.NO_COLOR;
        process.env.FORCE_COLOR = '1';
        assert.equal(supportsColor(), true);
    } finally {
        if (savedNoColor === undefined) { delete process.env.NO_COLOR; } else { process.env.NO_COLOR = savedNoColor; }
        if (savedForceColor === undefined) { delete process.env.FORCE_COLOR; } else { process.env.FORCE_COLOR = savedForceColor; }
    }
});

test('supportsColor: NO_COLOR takes precedence over FORCE_COLOR', () => {
    const savedNoColor = process.env.NO_COLOR;
    const savedForceColor = process.env.FORCE_COLOR;
    try {
        process.env.NO_COLOR = '1';
        process.env.FORCE_COLOR = '1';
        assert.equal(supportsColor(), false);
    } finally {
        if (savedNoColor === undefined) { delete process.env.NO_COLOR; } else { process.env.NO_COLOR = savedNoColor; }
        if (savedForceColor === undefined) { delete process.env.FORCE_COLOR; } else { process.env.FORCE_COLOR = savedForceColor; }
    }
});

test('buildHelpText includes --no-color in global options', () => {
    const text = buildHelpText({ name: 'test', version: '1.0.0' });
    assert.ok(text.includes('--no-color'));
    assert.ok(text.includes('NO_COLOR'));
    assert.ok(!text.includes('--bundle-name'));
});

test('buildHelpText documents aggregate retention override', () => {
    const text = buildHelpText({ name: 'test', version: '1.0.0' });
    assert.ok(text.includes('--max-aggregate-lines'));
    assert.ok(text.includes('aggregate task-event lines'));
});

test('buildHelpText documents working-plan retention override', () => {
    const text = buildHelpText({ name: 'test', version: '1.0.0' });
    assert.ok(text.includes('--max-working-plans'));
    assert.ok(text.includes('working plans'));
});

test('buildHelpText renders cleanup retention defaults from policy metadata', () => {
    const text = buildHelpText({ name: 'test', version: '1.0.0' });
    const defaults = buildDefaultRetentionPolicy();
    for (const item of RETENTION_POLICY_DEFAULTS) {
        assert.ok(
            text.includes(`${defaults[item.policyKey]} ${item.label}`),
            `help should include default for ${String(item.policyKey)}`
        );
        assert.ok(text.includes(item.flag), `help should include override flag ${item.flag}`);
    }
});

test('runCliMain with --no-color sets NO_COLOR and disables supportsColor', async () => {
    const { runCliMain } = await import('../../../../src/cli/main');
    const savedNoColor = process.env.NO_COLOR;
    const savedForceColor = process.env.FORCE_COLOR;
    try {
        delete process.env.NO_COLOR;
        delete process.env.FORCE_COLOR;
        await runCliMain(['--no-color', 'help']);
        assert.equal(process.env.NO_COLOR, '1', '--no-color flag should set NO_COLOR=1');
        assert.equal(supportsColor(), false, 'supportsColor should return false after --no-color');
    } finally {
        if (savedNoColor === undefined) { delete process.env.NO_COLOR; } else { process.env.NO_COLOR = savedNoColor; }
        if (savedForceColor === undefined) { delete process.env.FORCE_COLOR; } else { process.env.FORCE_COLOR = savedForceColor; }
    }
});

function createSourceCheckoutWithoutDeployedBundle(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-help-parity-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n', 'utf8');
    fs.writeFileSync(path.join(root, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator', version: '1.0.0' }), 'utf8');
    fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0\n', 'utf8');
    return root;
}

function createSourceCheckoutWithVersionMismatchedDeployedBundle(): string {
    const root = createSourceCheckoutWithoutDeployedBundle();
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '0.9.0\n', 'utf8');
    return root;
}

async function captureRunCliMain(argv: string[], options: { cwd?: string } = {}): Promise<string> {
    const { runCliMain } = await import('../../../../src/cli/main');
    const savedNoColor = process.env.NO_COLOR;
    const savedCwd = process.cwd();
    const captured: string[] = [];
    const originalLog = console.log;
    try {
        if (options.cwd) {
            process.chdir(options.cwd);
        }
        process.env.NO_COLOR = '1';
        console.log = (...args: unknown[]): void => {
            captured.push(args.map((arg) => String(arg)).join(' '));
        };
        await runCliMain(argv);
    } finally {
        console.log = originalLog;
        if (process.cwd() !== savedCwd) {
            process.chdir(savedCwd);
        }
        if (savedNoColor === undefined) { delete process.env.NO_COLOR; } else { process.env.NO_COLOR = savedNoColor; }
    }
    return captured.join('\n');
}

test('runCliMain prints command help for the user-facing invocation matrix', async () => {
    const sourceCheckoutRoot = createSourceCheckoutWithoutDeployedBundle();
    const commands: Array<{ command: string; expectedUsage: string }> = [
        { command: 'stats', expectedUsage: 'garda stats' },
        { command: 'task', expectedUsage: 'garda task' },
        { command: 'status', expectedUsage: 'garda status' },
        { command: 'doctor', expectedUsage: 'garda doctor' },
        { command: 'uninstall', expectedUsage: 'garda uninstall' },
        { command: 'cleanup', expectedUsage: 'garda cleanup' },
        { command: 'gc', expectedUsage: 'garda gc' },
        { command: 'profile', expectedUsage: 'garda profile' },
        { command: 'review-capabilities', expectedUsage: 'garda review-capabilities' },
        { command: 'review-catalog', expectedUsage: 'garda review-catalog' },
        { command: 'templates', expectedUsage: 'garda templates' }
    ];

    try {
        for (const { command, expectedUsage } of commands) {
            const invocations = [
                ['help', command],
                [command, 'help'],
                [command, '--help'],
                [command, '-h']
            ];
            for (const argv of invocations) {
                const text = await captureRunCliMain(argv, { cwd: sourceCheckoutRoot });
                assert.ok(text.includes('GARDA_COMMAND_HELP'), `${argv.join(' ')} should print command help`);
                assert.ok(text.includes(command), `${argv.join(' ')} should name the command`);
                assert.ok(text.includes(expectedUsage), `${argv.join(' ')} should include command-specific usage`);
            }
        }
    } finally {
        fs.rmSync(sourceCheckoutRoot, { recursive: true, force: true });
    }
});

test('runCliMain prints debug help for namespace and debug env help forms', async () => {
    const invocations = [
        ['help', 'debug'],
        ['debug', 'help'],
        ['debug', '--help'],
        ['debug', '-h'],
        ['debug', 'env', 'help'],
        ['debug', 'env', '--help'],
        ['debug', 'env', '-h']
    ];

    for (const argv of invocations) {
        const text = await captureRunCliMain(argv);
        assert.ok(text.includes('GARDA_COMMAND_HELP'), `${argv.join(' ')} should print command help`);
        assert.ok(text.includes('debug'), `${argv.join(' ')} should name debug`);
        assert.ok(text.includes('garda debug env'), `${argv.join(' ')} should include debug env usage`);
    }
});

test('runCliMain command help does not execute side-effect-prone command bodies', async () => {
    const sourceCheckoutRoot = createSourceCheckoutWithoutDeployedBundle();
    const doctorInvocations = [
        ['doctor', '--help'],
        ['doctor', '-h'],
        ['doctor', 'help'],
        ['help', 'doctor']
    ];
    try {
        for (const argv of doctorInvocations) {
            const text = await captureRunCliMain(argv, { cwd: sourceCheckoutRoot });
            assert.ok(text.includes('GARDA_COMMAND_HELP'), `${argv.join(' ')} should print command help`);
            assert.ok(text.includes('garda doctor'), `${argv.join(' ')} should include doctor usage`);
            assert.ok(!text.includes('Workspace ready'), `${argv.join(' ')} should not run status formatting`);
            assert.ok(!text.includes('Agent setup required'), `${argv.join(' ')} should not run status formatting`);
            assert.ok(!text.includes('Not installed'), `${argv.join(' ')} should not run status formatting`);
        }

        const cleanupInvocations = [
            ['cleanup', '--help'],
            ['cleanup', '-h'],
            ['cleanup', 'help'],
            ['help', 'cleanup'],
            ['gc', '--help'],
            ['gc', '-h'],
            ['gc', 'help'],
            ['help', 'gc']
        ];
        for (const argv of cleanupInvocations) {
            const text = await captureRunCliMain(argv, { cwd: sourceCheckoutRoot });
            assert.ok(text.includes('GARDA_COMMAND_HELP'), `${argv.join(' ')} should print command help`);
            assert.ok(text.includes('ledger history') || text.includes('ledger-only') || text.includes('verified ledger'), `${argv.join(' ')} should explain ledger retention`);
            assert.ok(text.includes('confirmed purge') || text.includes('Full purge is never automatic'), `${argv.join(' ')} should explain confirm-only purge`);
            assert.ok(text.includes('--runtime-retention-older-than-days'), `${argv.join(' ')} should document runtime retention age overrides`);
            assert.ok(text.includes('--runtime-retention-keep-latest-tasks'), `${argv.join(' ')} should document runtime retention count overrides`);
            assert.ok(!text.includes('GARDA_CLEANUP'), `${argv.join(' ')} should not run cleanup`);
        }

        const statsInvocations = [
            ['stats', '--help'],
            ['stats', '-h'],
            ['stats', 'help'],
            ['help', 'stats']
        ];
        for (const argv of statsInvocations) {
            const text = await captureRunCliMain(argv, { cwd: sourceCheckoutRoot });
            assert.ok(text.includes('GARDA_COMMAND_HELP'), `${argv.join(' ')} should print command help`);
            assert.ok(!text.includes('GARDA_STATS'), `${argv.join(' ')} should not run stats`);
        }
    } finally {
        fs.rmSync(sourceCheckoutRoot, { recursive: true, force: true });
    }
});

test('runCliMain prints gate help through overview and per-gate aliases', async () => {
    const sourceCheckoutRoot = createSourceCheckoutWithoutDeployedBundle();
    const overviewInvocations = [
        ['help', 'gate'],
        ['gate', 'help'],
        ['gate', '--help'],
        ['gate', '-h']
    ];
    try {
        for (const argv of overviewInvocations) {
            const text = await captureRunCliMain(argv, { cwd: sourceCheckoutRoot });
            assert.ok(text.includes('GARDA_COMMAND_HELP'), `${argv.join(' ')} should print gate overview help`);
            assert.ok(text.includes('gate <gate-name>'), `${argv.join(' ')} should include gate overview usage`);
        }

        const perGateInvocations = [
            ['help', 'gate', 'task-events-summary'],
            ['gate', 'help', 'task-events-summary'],
            ['gate', 'task-events-summary', '--help'],
            ['gate', 'task-events-summary', '-h']
        ];
        for (const argv of perGateInvocations) {
            const text = await captureRunCliMain(argv, { cwd: sourceCheckoutRoot });
            assert.ok(text.includes('GARDA_COMMAND_HELP'), `${argv.join(' ')} should print per-gate help`);
            assert.ok(text.includes('gate task-events-summary'), `${argv.join(' ')} should include per-gate usage`);
            assert.ok(text.includes('--task-id "<task-id>"'), `${argv.join(' ')} should include task-id syntax`);
        }
    } finally {
        fs.rmSync(sourceCheckoutRoot, { recursive: true, force: true });
    }
});

test('runCliMain prints help-only commands without requiring deployed bundle parity', async () => {
    const sourceCheckoutRoot = createSourceCheckoutWithoutDeployedBundle();
    try {
        const helpCases: Array<{ argv: string[]; expected: string }> = [
            { argv: ['profile', '--help'], expected: 'garda profile' },
            { argv: ['gate', '--help'], expected: 'gate <gate-name>' },
            { argv: ['gate', 'task-events-summary', '--help'], expected: 'gate task-events-summary' }
        ];
        for (const helpCase of helpCases) {
            const text = await captureRunCliMain(helpCase.argv, { cwd: sourceCheckoutRoot });
            assert.ok(text.includes('GARDA_COMMAND_HELP'), `${helpCase.argv.join(' ')} should print command help`);
            assert.ok(text.includes(helpCase.expected), `${helpCase.argv.join(' ')} should include expected usage`);
            assert.ok(!text.includes('PARITY_BLOCKED'), `${helpCase.argv.join(' ')} should not run parity blocking`);
        }
    } finally {
        fs.rmSync(sourceCheckoutRoot, { recursive: true, force: true });
    }
});

test('dispatchCliCommand still blocks help-only commands when deployed bundle version mismatches source', async () => {
    const sourceCheckoutRoot = createSourceCheckoutWithVersionMismatchedDeployedBundle();
    const savedCwd = process.cwd();
    try {
        process.chdir(sourceCheckoutRoot);
        await assert.rejects(
            () => dispatchCliCommand({
                commandName: 'profile',
                commandArgv: ['--help'],
                packageJson: { name: 'garda-agent-orchestrator', version: '1.0.0' },
                packageRoot: sourceCheckoutRoot,
                globalFlags: { offline: false, forceNetwork: false }
            }),
            (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                assert.ok(message.includes('PARITY_BLOCKED'));
                assert.ok(message.includes("Deployed bundle version '0.9.0' does not match source checkout version '1.0.0'."));
                assert.ok(message.includes('GARDA_COMMAND_HELP'));
                assert.ok(message.includes('garda profile'));
                return true;
            }
        );
    } finally {
        if (process.cwd() !== savedCwd) {
            process.chdir(savedCwd);
        }
        fs.rmSync(sourceCheckoutRoot, { recursive: true, force: true });
    }
});
