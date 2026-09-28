import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    EMBEDDED_BUNDLE_PARITY_ITEMS,
    formatEmbeddedBundleParityResult,
    validateEmbeddedBundleParity
} from '../../../scripts/node-foundation/validate-release';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function seedSurfaceItem(rootPath: string, item: string, label: string): void {
    if (item === 'bin') {
        writeFile(path.join(rootPath, item, 'garda.js'), `console.log("${label} bin");\n`);
        return;
    }
    if (item === 'dist') {
        writeFile(path.join(rootPath, item, 'src', 'index.js'), `module.exports = "${label} dist";\n`);
        return;
    }
    if (item === 'src') {
        writeFile(path.join(rootPath, item, 'index.ts'), `export const label = "${label} src";\n`);
        return;
    }
    if (item === 'template') {
        writeFile(path.join(rootPath, item, 'AGENTS.md'), `# ${label} template\n`);
        return;
    }
    writeFile(path.join(rootPath, item), `${label} ${item}\n`);
}

function createParityFixture(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-embedded-parity-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');

    for (const item of EMBEDDED_BUNDLE_PARITY_ITEMS) {
        seedSurfaceItem(repoRoot, item, 'root');
        fs.cpSync(path.join(repoRoot, item), path.join(bundleRoot, item), { recursive: true });
    }
    writeFile(path.join(repoRoot, 'VERSION'), '1.0.0\n');
    writeFile(path.join(bundleRoot, 'VERSION'), '1.0.0\n');

    return repoRoot;
}

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('validateEmbeddedBundleParity passes for identical generated bundle surface', () => {
    const repoRoot = createParityFixture();
    try {
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.passed, true, formatEmbeddedBundleParityResult(result));
        assert.equal(result.bundlePresent, true);
        assert.equal(result.status, 'PASSED');
        assert.equal(result.required, true);
        assert.equal(result.items.length, EMBEDDED_BUNDLE_PARITY_ITEMS.length);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity explicitly skips an optional missing bundle without PASS', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-embedded-parity-omitted-'));
    try {
        const result = validateEmbeddedBundleParity(repoRoot, EMBEDDED_BUNDLE_PARITY_ITEMS, { required: false });
        const output = formatEmbeddedBundleParityResult(result);
        assert.equal(result.passed, false, output);
        assert.equal(result.status, 'SKIPPED');
        assert.equal(result.required, false);
        assert.ok(result.skippedReason);
        assert.equal(result.bundlePresent, false);
        assert.match(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_SKIPPED/);
        assert.doesNotMatch(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity explicitly skips an optional ignored bundle without PASS', () => {
    const repoRoot = createParityFixture();
    try {
        writeFile(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/\n');
        runGit(repoRoot, ['-c', 'init.defaultBranch=main', 'init']);
        writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), 'console.log("stale ignored bundle");\n');

        const result = validateEmbeddedBundleParity(repoRoot, EMBEDDED_BUNDLE_PARITY_ITEMS, { required: false });
        const output = formatEmbeddedBundleParityResult(result);

        assert.equal(result.passed, false, output);
        assert.equal(result.status, 'SKIPPED');
        assert.equal(result.required, false);
        assert.ok(result.skippedReason);
        assert.equal(result.bundlePresent, true);
        assert.equal(result.bundleIgnoredByGit, true);
        assert.equal(result.items.length, 0);
        assert.match(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_SKIPPED/);
        assert.doesNotMatch(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity explicitly skips optional zero-item parity without PASS', () => {
    const repoRoot = createParityFixture();
    try {
        const result = validateEmbeddedBundleParity(repoRoot, [], { required: false });
        const output = formatEmbeddedBundleParityResult(result);

        assert.equal(result.passed, false, output);
        assert.equal(result.status, 'SKIPPED');
        assert.equal(result.required, false);
        assert.ok(result.skippedReason);
        assert.equal(result.bundlePresent, true);
        assert.equal(result.items.length, 0);
        assert.match(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_SKIPPED/);
        assert.doesNotMatch(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK/);
        assert.match(output, /ParityStatus: SKIPPED/);
        assert.match(output, /CheckedItems: 0/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity fails on root-only source changes', () => {
    const repoRoot = createParityFixture();
    try {
        writeFile(path.join(repoRoot, 'src', 'validators', 'status.ts'), 'export const changed = true;\n');
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some((violation) => violation.includes('src: hash mismatch')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity fails on root-only dist changes', () => {
    const repoRoot = createParityFixture();
    try {
        writeFile(path.join(repoRoot, 'dist', 'src', 'validators', 'status.js'), 'exports.changed = true;\n');
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some((violation) => violation.includes('dist: hash mismatch')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity fails when runtime-referenced docs are missing from bundle', () => {
    const repoRoot = createParityFixture();
    try {
        fs.rmSync(path.join(repoRoot, 'garda-agent-orchestrator', 'docs'), { recursive: true, force: true });
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(
            result.violations.some((violation) =>
                violation.includes('docs/operator-consistency-runbook.md: missing root=true bundle=false')
            )
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity fails when equal VERSION hides different files', () => {
    const repoRoot = createParityFixture();
    try {
        writeFile(path.join(repoRoot, 'bin', 'garda.js'), 'console.log("new launcher");\n');
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.passed, false);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim(), '1.0.0');
        assert.equal(
            fs.readFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'VERSION'), 'utf8').trim(),
            '1.0.0'
        );
        assert.ok(result.violations.some((violation) => violation.includes('bin: hash mismatch')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});


test('validateEmbeddedBundleParity rejects a missing mandatory bundle', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-parity-required-missing-'));
    try {
        const result = validateEmbeddedBundleParity(repoRoot);
        const output = formatEmbeddedBundleParityResult(result);
        assert.equal(result.passed, false, output);
        assert.equal(result.status, 'FAILED');
        assert.equal(result.required, true);
        assert.equal(result.items.length, 0);
        assert.match(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_FAILED/);
        assert.match(output, /Embedded bundle is missing/);
        assert.match(output, /CheckedItems: 0/);
        assert.doesNotMatch(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK|ParityStatus: PASSED/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity inspects every item of an ignored mandatory bundle', () => {
    const repoRoot = createParityFixture();
    try {
        writeFile(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/\n');
        runGit(repoRoot, ['-c', 'init.defaultBranch=main', 'init']);
        const result = validateEmbeddedBundleParity(repoRoot);
        const output = formatEmbeddedBundleParityResult(result);
        assert.equal(result.passed, true, output);
        assert.equal(result.status, 'PASSED');
        assert.equal(result.bundleIgnoredByGit, true);
        assert.equal(result.items.length, EMBEDDED_BUNDLE_PARITY_ITEMS.length);
        assert.equal(result.skippedReason, null);
        assert.match(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('mandatory ignored bundle inspection detects stale content and missing docs', () => {
    const repoRoot = createParityFixture();
    try {
        writeFile(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/\n');
        runGit(repoRoot, ['-c', 'init.defaultBranch=main', 'init']);
        writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), 'stale runtime\n');
        fs.unlinkSync(path.join(repoRoot, 'garda-agent-orchestrator', 'docs', 'architecture.md'));

        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.status, 'FAILED');
        assert.equal(result.passed, false);
        assert.equal(result.bundleIgnoredByGit, true);
        assert.equal(result.items.length, EMBEDDED_BUNDLE_PARITY_ITEMS.length);
        assert.ok(result.violations.includes('bin: hash mismatch'));
        assert.ok(result.violations.includes('docs/architecture.md: missing root=true bundle=false'));
        const command = runParityCommand(repoRoot, true);
        assert.equal(command.status, 1, command.stderr || command.stdout);
        assert.match(command.stdout, /RELEASE_EMBEDDED_BUNDLE_PARITY_FAILED/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('mandatory parity rejects an ignored bundle-root junction aliasing the repository', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-parity-root-alias-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    try {
        for (const item of EMBEDDED_BUNDLE_PARITY_ITEMS) seedSurfaceItem(repoRoot, item, 'root');
        writeFile(path.join(repoRoot, '.gitignore'), 'garda-agent-orchestrator/\n');
        runGit(repoRoot, ['-c', 'init.defaultBranch=main', 'init']);
        fs.symlinkSync(repoRoot, bundleRoot, process.platform === 'win32' ? 'junction' : 'dir');
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.status, 'FAILED');
        assert.equal(result.passed, false);
        assert.equal(result.items.length, 0);
        assert.match(result.violations.join('\n'), /Invalid embedded bundle boundary.*symlink or junction/);
        const command = runParityCommand(repoRoot, true);
        assert.equal(command.status, 1, command.stderr || command.stdout);
        assert.match(command.stdout, /RELEASE_EMBEDDED_BUNDLE_PARITY_FAILED/);
        assert.doesNotMatch(command.stdout, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK/);
    } finally {
        if (fs.existsSync(bundleRoot)) fs.unlinkSync(bundleRoot);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

for (const surface of ['root', 'bundle'] as const) {
    test(`mandatory parity rejects a linked document ancestor on the ${surface} surface`, () => {
        const repoRoot = createParityFixture();
        try {
            const surfaceRoot = surface === 'root' ? repoRoot : path.join(repoRoot, 'garda-agent-orchestrator');
            const docs = path.join(surfaceRoot, 'docs');
            const savedDocs = path.join(surfaceRoot, 'saved-docs');
            fs.renameSync(docs, savedDocs);
            fs.symlinkSync(savedDocs, docs, process.platform === 'win32' ? 'junction' : 'dir');
            const result = validateEmbeddedBundleParity(repoRoot);
            assert.equal(result.status, 'FAILED');
            assert.equal(result.passed, false);
            assert.match(result.violations.join('\n'), /symlink or junction/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
}

test('mandatory parity rejects a shared hard-linked file', () => {
    const repoRoot = createParityFixture();
    try {
        const bundleReadme = path.join(repoRoot, 'garda-agent-orchestrator', 'README.md');
        fs.unlinkSync(bundleReadme);
        fs.linkSync(path.join(repoRoot, 'README.md'), bundleReadme);
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.status, 'FAILED');
        assert.equal(result.passed, false);
        assert.match(result.violations.join('\n'), /hard-linked/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('mandatory parity revalidates bundle identity after Git inspection', (context) => {
    const repoRoot = createParityFixture();
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    let replaced = false;
    try {
        const nativeChildProcess = require('node:child_process') as typeof childProcess;
        const originalSpawn = nativeChildProcess.spawnSync;
        context.mock.method(nativeChildProcess, 'spawnSync', (...args: Parameters<typeof childProcess.spawnSync>) => {
            const result = originalSpawn(...args);
            if (!replaced && args[0] === 'git') {
                fs.renameSync(bundleRoot, path.join(repoRoot, 'prior-bundle'));
                fs.symlinkSync(repoRoot, bundleRoot, process.platform === 'win32' ? 'junction' : 'dir');
                replaced = true;
            }
            return result;
        });
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(replaced, true);
        assert.equal(result.status, 'FAILED');
        assert.equal(result.passed, false);
        assert.equal(result.items.length, 0);
    } finally {
        if (replaced) fs.unlinkSync(bundleRoot);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity rejects zero selected mandatory items', () => {
    const repoRoot = createParityFixture();
    try {
        const result = validateEmbeddedBundleParity(repoRoot, []);
        const output = formatEmbeddedBundleParityResult(result);
        assert.equal(result.passed, false, output);
        assert.equal(result.status, 'FAILED');
        assert.equal(result.items.length, 0);
        assert.match(output, /No embedded bundle parity items were selected/);
        assert.match(output, /CheckedItems: 0/);
        assert.doesNotMatch(output, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK|ParityStatus: PASSED/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity rejects missing required inputs on both surfaces', () => {
    const repoRoot = createParityFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'package.json'));
        fs.unlinkSync(path.join(repoRoot, 'garda-agent-orchestrator', 'package.json'));
        const result = validateEmbeddedBundleParity(repoRoot);
        assert.equal(result.passed, false);
        assert.equal(result.status, 'FAILED');
        assert.ok(result.violations.includes('package.json: missing root=false bundle=false'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateEmbeddedBundleParity rejects replaced content even for an optional check', () => {
    const repoRoot = createParityFixture();
    try {
        writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), 'console.log("replaced");\n');
        const result = validateEmbeddedBundleParity(repoRoot, EMBEDDED_BUNDLE_PARITY_ITEMS, { required: false });
        assert.equal(result.passed, false);
        assert.equal(result.status, 'FAILED');
        assert.equal(result.skippedReason, null);
        assert.ok(result.violations.includes('bin: hash mismatch'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

function runParityCommand(repoRoot: string, required: boolean): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync(process.execPath, ['-e',
        'require(process.argv[2]).getRepoRoot = () => process.argv[3]; ' +
        'require(process.argv[1]).runEmbeddedBundleParityValidation({ required: process.argv[4] === "true" });',
        require.resolve('../../../scripts/node-foundation/release-validation/embedded-bundle-parity'),
        require.resolve('../../../scripts/node-foundation/build'), repoRoot, String(required)],
    { encoding: 'utf8', windowsHide: true });
}

test('embedded parity command rejects a missing mandatory bundle with nonzero exit', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-parity-command-missing-'));
    try {
        const result = runParityCommand(repoRoot, true);
        assert.equal(result.status, 1, result.stderr || result.stdout);
        assert.match(result.stdout, /RELEASE_EMBEDDED_BUNDLE_PARITY_FAILED/);
        assert.doesNotMatch(result.stdout, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('embedded parity command permits an explicit optional skip without PASS', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-parity-command-optional-'));
    try {
        const result = runParityCommand(repoRoot, false);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /RELEASE_EMBEDDED_BUNDLE_PARITY_SKIPPED/);
        assert.match(result.stdout, /Required: no/);
        assert.doesNotMatch(result.stdout, /RELEASE_EMBEDDED_BUNDLE_PARITY_OK|ParityStatus: PASSED/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
