import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    assertReleaseArchiveBudget,
    assertSupportedTarLinkTarget,
    buildReleaseArchivePlan,
    createReleaseArchive,
    writeReleaseArchivePlan
} from '../../../scripts/node-foundation/archive-release';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

function hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readArchiveManifest(archivePath: string): {
    schema_version: number;
    archive_kind: string;
    entry_count: number;
    entries: Array<{ relativePath: string; size: number; sha256: string }>;
} {
    const archive = fs.readFileSync(archivePath);
    assert.equal(archive.toString('utf8', 0, 21), 'ARCHIVE-MANIFEST.json');
    const size = Number.parseInt(archive.toString('ascii', 124, 136).replace(/\0.*$/u, '').trim(), 8);
    return JSON.parse(archive.toString('utf8', 512, 512 + size)) as ReturnType<typeof readArchiveManifest>;
}

function createArchiveFixture(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-release-archive-'));

    writeFile(path.join(repoRoot, 'package.json'), '{"name":"fixture"}\n');
    writeFile(path.join(repoRoot, 'src', 'index.ts'), 'export const value = 1;\n');
    writeFile(path.join(repoRoot, 'src', ' leading.ts'), 'export const spaced = true;\n');
    writeFile(path.join(repoRoot, 'docs', 'run-methods.md'), '# Run\n');
    writeFile(path.join(repoRoot, 'node_modules', 'platform-package', 'index.js'), 'generated dependency\n');
    writeFile(path.join(repoRoot, '.node-build', 'src', 'index.js'), 'generated build\n');
    writeFile(path.join(repoRoot, '.scripts-build', 'scripts', 'tool.js'), 'generated script build\n');
    writeFile(path.join(repoRoot, 'coverage', 'lcov.info'), 'TN:\n');
    writeFile(path.join(repoRoot, 'dist', 'src', 'index.js'), 'generated runtime\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-final-user-report.md'), 'report\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-code-review-context.md'), 'generated context\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-scoped-diff-summary.json'), '{}\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', 'T-001.jsonl'), '{}\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'npm-test.log'), 'ok\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'tmp', 'scratch.log'), 'transient\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'coverage', 'lcov.info'), 'transient\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), '{"Secret":"no"}\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', '.env'), 'SECRET=no\n');
    writeFile(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'credentials.json'), '{"opaque":"redacted"}\n');

    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['add', '.']);

    return repoRoot;
}

test('source release archive plan is tracked-source only and excludes generated runtime noise', () => {
    const repoRoot = createArchiveFixture();
    try {
        const plan = buildReleaseArchivePlan('source', repoRoot, path.join(repoRoot, 'release-archives', 'source.tar'));
        const entries = plan.entries.map((entry) => entry.relativePath);

        assert.deepEqual(entries, [
            'docs/run-methods.md',
            'package.json',
            'src/ leading.ts',
            'src/index.ts'
        ]);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('evidence release archive plan is allowlisted evidence only and skips secrets', () => {
    const repoRoot = createArchiveFixture();
    try {
        const plan = buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar'));
        const entries = plan.entries.map((entry) => entry.relativePath);

        assert.deepEqual(entries, [
            'garda-agent-orchestrator/runtime/manual-validation/T-001/npm-test.log',
            'garda-agent-orchestrator/runtime/reviews/T-001-final-user-report.md',
            'garda-agent-orchestrator/runtime/task-events/T-001.jsonl'
        ]);
        assert.ok(!entries.some((entry) => entry.includes('init-answers')));
        assert.ok(!entries.some((entry) => entry.endsWith('/.env')));
        assert.ok(!entries.some((entry) => entry.endsWith('/credentials.json')));
        assert.ok(!entries.some((entry) => entry.endsWith('-review-context.md')));
        assert.ok(!entries.some((entry) => entry.endsWith('-scoped-diff-summary.json')));
        assert.ok(!entries.some((entry) => entry.includes('/tmp/') || entry.includes('/coverage/')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('evidence release archive plan fails closed on credential-like content', () => {
    const repoRoot = createArchiveFixture();
    try {
        writeFile(
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'activity.log'),
            'AUTH_TOKEN=abcd1234abcd1234abcd1234\n'
        );

        assert.throws(
            () => buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar')),
            /credential-like content/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('evidence release archive plan scans oversized credential-like text evidence', () => {
    const repoRoot = createArchiveFixture();
    try {
        writeFile(
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'large.log'),
            `${'x'.repeat(1024 * 1024 + 32)}\nAUTH_TOKEN=abcd1234abcd1234abcd1234\n`
        );

        assert.throws(
            () => buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar')),
            /credential-like content/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('embedded NUL bytes cannot hide credential-like evidence content', () => {
    const repoRoot = createArchiveFixture();
    try {
        writeFile(
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'binary.log'),
            'binary\0payload\0AUTH_TOKEN=abcd1234abcd1234abcd1234\n'
        );
        assert.throws(
            () => buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar')),
            /credential-like content/u
        );
        fs.rmSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'binary.log'));
        writeFile(
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'utf16.log'),
            Buffer.from('AUTH_TOKEN=abcd1234abcd1234abcd1234\n', 'utf16le').toString('binary')
        );
        assert.throws(
            () => buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar')),
            /credential-like content/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('NUL padding across evidence scan chunks cannot hide a credential', () => {
    const repoRoot = createArchiveFixture();
    try {
        const heading = `${'x'.repeat(1024 * 1024 - 5012)}\nAUTH_TOKEN=`;
        writeFile(
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'split.log'),
            `${heading}${'\0'.repeat(10000)}abcd1234abcd1234abcd1234\n`
        );
        assert.throws(
            () => buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar')),
            /credential-like content/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('evidence symlink targets are scanned for credential-like content', (t) => {
    const repoRoot = createArchiveFixture();
    try {
        const linkPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'shortcut');
        try {
            fs.symlinkSync('AUTH_TOKEN=abcd1234abcd1234abcd1234', linkPath, 'file');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                t.skip('File symlink creation is unavailable on this host.');
                return;
            }
            throw error;
        }
        assert.throws(
            () => buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar')),
            /credential-like target/u
        );
        fs.rmSync(linkPath);
        fs.symlinkSync('../../../../../../outside', linkPath, 'file');
        assert.throws(
            () => buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar')),
            /Unsupported archive symlink target/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('UTF-16 byte-order marks do not hide evidence credentials', () => {
    const repoRoot = createArchiveFixture();
    try {
        const filePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'manual-validation', 'T-001', 'encoded.log');
        const content = Buffer.from('AUTH_TOKEN=abcd1234abcd1234abcd1234\n', 'utf16le');
        const bigEndian = Buffer.from(content);
        for (let index = 0; index < bigEndian.length; index += 2) {
            [bigEndian[index], bigEndian[index + 1]] = [bigEndian[index + 1], bigEndian[index]];
        }
        for (const encoded of [Buffer.concat([Buffer.from([0xff, 0xfe]), content]), Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian])]) {
            fs.writeFileSync(filePath, encoded);
            assert.throws(
                () => buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar')),
                /credential-like content/u
            );
        }
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('evidence traversal has a finite directory-depth budget', () => {
    const repoRoot = createArchiveFixture();
    try {
        let directory = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        for (let depth = 0; depth < 66; depth += 1) {
            directory = path.join(directory, 'd');
            fs.mkdirSync(directory);
        }
        writeFile(path.join(directory, 'report.log'), 'ok\n');
        assert.throws(
            () => buildReleaseArchivePlan('evidence', repoRoot, path.join(repoRoot, 'release-archives', 'evidence.tar')),
            /Archive evidence directory depth exceeded/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('archive budget and tar link limits reject excessive values before serialization', () => {
    assert.doesNotThrow(() => assertReleaseArchiveBudget(50_000, 2 * 1024 * 1024 * 1024));
    assert.throws(() => assertReleaseArchiveBudget(50_001, 0), /entry budget exceeded/u);
    assert.throws(() => assertReleaseArchiveBudget(-1, 0), /entry budget exceeded/u);
    assert.throws(() => assertReleaseArchiveBudget(1, 2 * 1024 * 1024 * 1024 + 1), /input-byte budget exceeded/u);
    assert.throws(() => assertReleaseArchiveBudget(1, -1), /input-byte budget exceeded/u);
    assert.doesNotThrow(() => assertSupportedTarLinkTarget('é'.repeat(50), 'link'));
    assert.throws(() => assertSupportedTarLinkTarget('é'.repeat(51), 'link'), /Unsupported archive symlink target/u);
    assert.throws(() => assertSupportedTarLinkTarget('safe\0hidden', 'link'), /Unsupported archive symlink target/u);
    assert.throws(() => assertSupportedTarLinkTarget('/outside', 'nested/link'), /Unsupported archive symlink target/u);
    assert.throws(() => assertSupportedTarLinkTarget('../../outside', 'nested/link'), /Unsupported archive symlink target/u);
    assert.throws(() => assertSupportedTarLinkTarget('C:escape', 'nested/link'), /Unsupported archive symlink target/u);
    assert.doesNotThrow(() => assertSupportedTarLinkTarget('../inside', 'nested/link'));
});

test('archive output cannot replace a selected source or evidence input', () => {
    const repoRoot = createArchiveFixture();
    try {
        const sourcePath = path.join(repoRoot, 'src', 'index.ts');
        const evidencePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-001-final-user-report.md');
        const sourceBefore = fs.readFileSync(sourcePath);
        const evidenceBefore = fs.readFileSync(evidencePath);
        assert.throws(() => createReleaseArchive('source', repoRoot, sourcePath), /Archive output overlaps selected input/u);
        const safePlan = buildReleaseArchivePlan('source', repoRoot, path.join(repoRoot, 'release-archives', 'source.tar'));
        assert.throws(() => writeReleaseArchivePlan({ ...safePlan, outputPath: sourcePath }), /Archive output overlaps selected input/u);
        assert.throws(() => createReleaseArchive('evidence', repoRoot, evidencePath), /Archive output overlaps selected input/u);
        const hardlinkPath = path.join(repoRoot, 'release-archives', 'source-hardlink.tar');
        fs.mkdirSync(path.dirname(hardlinkPath), { recursive: true });
        fs.linkSync(sourcePath, hardlinkPath);
        assert.throws(() => createReleaseArchive('source', repoRoot, hardlinkPath), /Archive output overlaps selected input/u);
        assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
        assert.deepEqual(fs.readFileSync(evidencePath), evidenceBefore);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('archive path validation rejects manifest descendants and drive-relative entries', () => {
    const repoRoot = createArchiveFixture();
    try {
        writeFile(path.join(repoRoot, 'ARCHIVE-MANIFEST.json', 'child.txt'), 'conflict\n');
        runGit(repoRoot, ['add', 'ARCHIVE-MANIFEST.json/child.txt']);
        assert.throws(
            () => buildReleaseArchivePlan('source', repoRoot, path.join(repoRoot, 'release-archives', 'source.tar')),
            /Unsafe archive path/u
        );
        fs.rmSync(path.join(repoRoot, 'ARCHIVE-MANIFEST.json'), { recursive: true });
        runGit(repoRoot, ['rm', '--cached', 'ARCHIVE-MANIFEST.json/child.txt']);
        if (process.platform !== 'win32') {
            writeFile(path.join(repoRoot, 'C:escape'), 'drive relative\n');
            runGit(repoRoot, ['add', 'C:escape']);
            assert.throws(
                () => buildReleaseArchivePlan('source', repoRoot, path.join(repoRoot, 'release-archives', 'source.tar')),
                /Unsafe archive path/u
            );
        }
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('writer consumes the frozen plan and rejects changed inputs without creating an archive', () => {
    const repoRoot = createArchiveFixture();
    try {
        const outputPath = path.join(repoRoot, 'release-archives', 'source.tar');
        const plan = buildReleaseArchivePlan('source', repoRoot, outputPath);
        assert.equal(Object.isFrozen(plan), true);
        assert.equal(Object.isFrozen(plan.entries), true);
        writeFile(path.join(repoRoot, 'src', 'added.ts'), 'new file\n');
        writeReleaseArchivePlan(plan);
        assert.equal(readArchiveManifest(outputPath).entry_count, plan.entries.length);
        fs.rmSync(outputPath);
        writeFile(path.join(repoRoot, 'src', 'index.ts'), 'export const value = 2;\n');
        assert.throws(() => writeReleaseArchivePlan(plan), /Archive input (identity|digest) changed/u);
        assert.equal(fs.existsSync(outputPath), false);
        assert.deepEqual(fs.readdirSync(path.dirname(outputPath)), []);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('archive writer rejects a redirected destination and parent directory', (t) => {
    const repoRoot = createArchiveFixture();
    try {
        const outputDirectory = path.join(repoRoot, 'release-archives');
        const outputPath = path.join(outputDirectory, 'source.tar');
        const outsideDirectory = path.join(repoRoot, 'redirected');
        fs.mkdirSync(outputDirectory);
        fs.mkdirSync(outsideDirectory);
        const outsidePath = path.join(outsideDirectory, 'preserve.tar');
        writeFile(outsidePath, 'preserve\n');
        const plan = buildReleaseArchivePlan('source', repoRoot, outputPath);
        try {
            fs.symlinkSync(outsidePath, outputPath, 'file');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                t.skip('File symlink creation is unavailable on this host.');
                return;
            }
            throw error;
        }
        assert.throws(() => writeReleaseArchivePlan(plan), /Unsafe archive output path/u);
        assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'preserve\n');

        fs.rmSync(outputPath);
        fs.rmSync(outputDirectory, { recursive: true });
        fs.symlinkSync(outsideDirectory, outputDirectory, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => writeReleaseArchivePlan(plan), /Unsafe archive output directory/u);
        assert.equal(fs.existsSync(path.join(outsideDirectory, 'source.tar')), false);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('large archive entry is written without concatenating the tar payload', () => {
    const repoRoot = createArchiveFixture();
    const originalConcat = Buffer.concat;
    try {
        const largePath = path.join(repoRoot, 'src', 'large.bin');
        fs.writeFileSync(largePath, Buffer.alloc(8 * 1024 * 1024, 0x61));
        runGit(repoRoot, ['add', 'src/large.bin']);
        const outputPath = path.join(repoRoot, 'release-archives', 'source.tar');
        Object.defineProperty(Buffer, 'concat', {
            configurable: true,
            writable: true,
            value: (parts: readonly Uint8Array[], totalLength?: number) => {
                const bytes = totalLength ?? parts.reduce((sum, part) => sum + part.length, 0);
                assert.ok(bytes < 2 * 1024 * 1024, 'tar payload must not be concatenated in memory');
                return originalConcat(parts, totalLength);
            }
        });
        createReleaseArchive('source', repoRoot, outputPath);
        assert.equal(readArchiveManifest(outputPath).entry_count, 5);
        assert.ok(fs.statSync(outputPath).size > 8 * 1024 * 1024);
    } finally {
        Object.defineProperty(Buffer, 'concat', { configurable: true, writable: true, value: originalConcat });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release archive output is deterministic for unchanged inputs', () => {
    const repoRoot = createArchiveFixture();
    try {
        const firstPath = path.join(repoRoot, 'release-archives', 'source-1.tar');
        const secondPath = path.join(repoRoot, 'release-archives', 'source-2.tar');

        const firstPlan = createReleaseArchive('source', repoRoot, firstPath);
        const secondPlan = createReleaseArchive('source', repoRoot, secondPath);

        assert.equal(firstPlan.entries.length, 4);
        assert.equal(secondPlan.entries.length, 4);
        assert.equal(hashFile(firstPath), hashFile(secondPath));
        assert.ok(fs.statSync(firstPath).size > 1024);
        const manifest = readArchiveManifest(firstPath);
        assert.equal(manifest.schema_version, 1);
        assert.equal(manifest.archive_kind, 'source');
        assert.deepEqual(Object.keys(manifest.entries[0]), ['relativePath', 'size', 'sha256']);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
