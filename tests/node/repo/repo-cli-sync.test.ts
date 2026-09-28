import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { syncRepoCliEntrypoint } from '../../../scripts/node-foundation/build';

function writeTextFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function createRepoCliFixture() {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-repo-cli-sync-'));
    const compiledRoot = path.join(tempRoot, 'compiled');
    const repoRoot = path.join(tempRoot, 'repo');
    const compiledCliPath = path.join(compiledRoot, 'src', 'bin', 'garda.js');
    const repoCliPath = path.join(repoRoot, 'bin', 'garda.js');
    const desiredContent = '#!/usr/bin/env node\nconsole.log("new launcher");\n';

    writeTextFile(compiledCliPath, desiredContent);
    writeTextFile(repoCliPath, '#!/usr/bin/env node\nconsole.log("old launcher");\n');

    return {
        tempRoot,
        compiledRoot,
        repoRoot,
        repoCliPath,
        desiredContent
    };
}

function runRepoCliSyncWorker(buildModulePath: string, compiledRoot: string, repoRoot: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const workerScript = [
            "const { syncRepoCliEntrypoint } = require(process.argv[1]);",
            "syncRepoCliEntrypoint(process.argv[2], process.argv[3]);"
        ].join('\n');

        const child = spawn(process.execPath, [
            '--input-type=commonjs',
            '--eval',
            workerScript,
            buildModulePath,
            compiledRoot,
            repoRoot
        ], {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });

        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr || `repo-cli sync worker exited with code ${code}`));
        });
    });
}

test('syncRepoCliEntrypoint tolerates transient EBUSY when peer already updated launcher', () => {
    const fixture = createRepoCliFixture();
    let renameAttempts = 0;

    try {
        const repoCliPath = syncRepoCliEntrypoint(fixture.compiledRoot, fixture.repoRoot, {
            chmodSync: fs.chmodSync.bind(fs),
            existsSync: fs.existsSync.bind(fs),
            mkdirSync: fs.mkdirSync.bind(fs),
            readFileSync: fs.readFileSync.bind(fs),
            readdirSync: fs.readdirSync.bind(fs),
            rmSync: fs.rmSync.bind(fs),
            statSync: fs.statSync.bind(fs),
            writeFileSync: fs.writeFileSync.bind(fs),
            renameSync(oldPath: fs.PathLike, newPath: fs.PathLike) {
                renameAttempts += 1;
                if (renameAttempts === 1) {
                    fs.writeFileSync(String(newPath), fixture.desiredContent, 'utf8');
                    const error = new Error('launcher temporarily busy') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
                return fs.renameSync(oldPath, newPath);
            }
        });
        const binEntries = fs.readdirSync(path.dirname(fixture.repoCliPath));

        assert.equal(repoCliPath, fixture.repoCliPath);
        assert.equal(fs.readFileSync(fixture.repoCliPath, 'utf8'), fixture.desiredContent);
        assert.equal(renameAttempts, 1);
        assert.ok(!binEntries.some((entry) => entry.endsWith('.tmp')), 'temp launcher files must be cleaned up');
        assert.ok(!binEntries.includes('.garda-cli-sync.lock'), 'lock directory must be removed after sync');
    } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
});

test('syncRepoCliEntrypoint publishes launcher companion modules', () => {
    const fixture = createRepoCliFixture();
    const companionContent = 'exports.value = "current";\n';
    const nestedContent = 'exports.nested = true;\n';

    try {
        writeTextFile(
            path.join(fixture.compiledRoot, 'src', 'bin', 'garda', 'root-discovery.js'),
            `${companionContent}//# sourceMappingURL=root-discovery.js.map\n`
        );
        writeTextFile(
            path.join(fixture.compiledRoot, 'src', 'bin', 'garda', 'nested', 'runtime-loading.js'),
            nestedContent
        );
        writeTextFile(
            path.join(fixture.repoRoot, 'bin', 'garda', 'stale.js'),
            'exports.value = "stale";\n'
        );

        const repoCliPath = syncRepoCliEntrypoint(fixture.compiledRoot, fixture.repoRoot);

        assert.equal(repoCliPath, fixture.repoCliPath);
        assert.equal(
            fs.readFileSync(path.join(fixture.repoRoot, 'bin', 'garda', 'root-discovery.js'), 'utf8'),
            companionContent
        );
        assert.equal(
            fs.readFileSync(path.join(fixture.repoRoot, 'bin', 'garda', 'nested', 'runtime-loading.js'), 'utf8'),
            nestedContent
        );
        assert.ok(!fs.existsSync(path.join(fixture.repoRoot, 'bin', 'garda', 'stale.js')));
    } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
});

test('syncRepoCliEntrypoint gives only the launcher executable mode and repairs companions on reuse', {
    skip: process.platform === 'win32'
}, () => {
    const fixture = createRepoCliFixture();
    const companionFiles = ['root-discovery.js', 'nested/runtime-loading.js', 'settings.json'];
    const compiledCompanionRoot = path.join(fixture.compiledRoot, 'src', 'bin', 'garda');
    const repoCompanionRoot = path.join(fixture.repoRoot, 'bin', 'garda');
    const assertModes = (): void => {
        assert.equal(fs.statSync(fixture.repoCliPath).mode & 0o777, 0o755);
        for (const relativePath of companionFiles) {
            assert.equal(fs.statSync(path.join(repoCompanionRoot, relativePath)).mode & 0o777, 0o644, relativePath);
        }
    };

    try {
        for (const relativePath of companionFiles) {
            writeTextFile(path.join(compiledCompanionRoot, relativePath), relativePath.endsWith('.json')
                ? '{"value":"current"}\n' : 'exports.value = "current";\n');
        }
        syncRepoCliEntrypoint(fixture.compiledRoot, fixture.repoRoot);
        assertModes();

        for (const relativePath of companionFiles) {
            fs.chmodSync(path.join(repoCompanionRoot, relativePath), 0o755);
        }
        fs.chmodSync(fixture.repoCliPath, 0o644);
        syncRepoCliEntrypoint(fixture.compiledRoot, fixture.repoRoot);
        assertModes();

        writeTextFile(path.join(compiledCompanionRoot, companionFiles[0]), 'exports.value = "updated";\n');
        syncRepoCliEntrypoint(fixture.compiledRoot, fixture.repoRoot);
        assertModes();
        assert.equal(fs.readFileSync(path.join(repoCompanionRoot, companionFiles[0]), 'utf8'), 'exports.value = "updated";\n');
    } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
});

test('syncRepoCliEntrypoint keeps prior launcher when companion sync fails', () => {
    const fixture = createRepoCliFixture();
    const previousCompanionContent = 'exports.value = "previous";\n';
    const nextCompanionContent = 'exports.value = "next";\n';
    const writeFileSync = fs.writeFileSync.bind(fs);

    try {
        writeTextFile(
            path.join(fixture.compiledRoot, 'src', 'bin', 'garda', 'root-discovery.js'),
            nextCompanionContent
        );
        writeTextFile(
            path.join(fixture.repoRoot, 'bin', 'garda', 'root-discovery.js'),
            previousCompanionContent
        );

        assert.throws(
            () => syncRepoCliEntrypoint(fixture.compiledRoot, fixture.repoRoot, {
                chmodSync: fs.chmodSync.bind(fs),
                existsSync: fs.existsSync.bind(fs),
                mkdirSync: fs.mkdirSync.bind(fs),
                readFileSync: fs.readFileSync.bind(fs),
                readdirSync: fs.readdirSync.bind(fs),
                renameSync: fs.renameSync.bind(fs),
                rmSync: fs.rmSync.bind(fs),
                statSync: fs.statSync.bind(fs),
                writeFileSync(filePath: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) {
                    if (String(filePath).includes(`root-discovery.js.${process.pid}`)) {
                        throw new Error('simulated companion write failure');
                    }
                    return writeFileSync(filePath, data);
                }
            }),
            /simulated companion write failure/
        );

        assert.equal(
            fs.readFileSync(fixture.repoCliPath, 'utf8'),
            '#!/usr/bin/env node\nconsole.log("old launcher");\n'
        );
        assert.equal(
            fs.readFileSync(path.join(fixture.repoRoot, 'bin', 'garda', 'root-discovery.js'), 'utf8'),
            previousCompanionContent
        );
    } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
});

test('syncRepoCliEntrypoint strips test-build source map footer from repo launcher', () => {
    const fixture = createRepoCliFixture();
    const mappedContent = `${fixture.desiredContent}//# sourceMappingURL=garda.js.map\n`;

    try {
        writeTextFile(path.join(fixture.compiledRoot, 'src', 'bin', 'garda.js'), mappedContent);

        const repoCliPath = syncRepoCliEntrypoint(fixture.compiledRoot, fixture.repoRoot);

        assert.equal(repoCliPath, fixture.repoCliPath);
        assert.equal(fs.readFileSync(fixture.repoCliPath, 'utf8'), fixture.desiredContent);
    } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
});

test('syncRepoCliEntrypoint falls back to lock when fast no-op launcher read is busy', () => {
    const fixture = createRepoCliFixture();
    let busyReads = 0;
    let lockAcquires = 0;

    try {
        fs.writeFileSync(fixture.repoCliPath, fixture.desiredContent, 'utf8');

        const repoCliPath = syncRepoCliEntrypoint(fixture.compiledRoot, fixture.repoRoot, {
            chmodSync: fs.chmodSync.bind(fs),
            existsSync: fs.existsSync.bind(fs),
            mkdirSync: ((filePath: fs.PathLike, options?: fs.Mode | fs.MakeDirectoryOptions | null) => {
                if (String(filePath).endsWith('.garda-cli-sync.lock')) {
                    lockAcquires += 1;
                }
                return fs.mkdirSync(filePath, options);
            }) as typeof fs.mkdirSync,
            readFileSync: ((filePath: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) => {
                if (String(filePath) === fixture.repoCliPath && busyReads === 0) {
                    busyReads += 1;
                    const error = new Error('launcher temporarily busy') as NodeJS.ErrnoException;
                    error.code = 'EPERM';
                    throw error;
                }
                return fs.readFileSync(filePath, options);
            }) as typeof fs.readFileSync,
            readdirSync: fs.readdirSync.bind(fs),
            renameSync: fs.renameSync.bind(fs),
            rmSync: fs.rmSync.bind(fs),
            statSync: fs.statSync.bind(fs),
            writeFileSync: fs.writeFileSync.bind(fs)
        });

        assert.equal(repoCliPath, fixture.repoCliPath);
        assert.equal(fs.readFileSync(fixture.repoCliPath, 'utf8'), fixture.desiredContent);
        assert.equal(busyReads, 1);
        assert.equal(lockAcquires, 1);
    } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
});

test('syncRepoCliEntrypoint serializes concurrent workers without leaving temp files', async () => {
    const fixture = createRepoCliFixture();
    const buildModulePath = path.resolve(__dirname, '../../../scripts/node-foundation/build.js');

    try {
        await Promise.all([
            runRepoCliSyncWorker(buildModulePath, fixture.compiledRoot, fixture.repoRoot),
            runRepoCliSyncWorker(buildModulePath, fixture.compiledRoot, fixture.repoRoot),
            runRepoCliSyncWorker(buildModulePath, fixture.compiledRoot, fixture.repoRoot)
        ]);

        const binEntries = fs.readdirSync(path.dirname(fixture.repoCliPath));
        assert.equal(fs.readFileSync(fixture.repoCliPath, 'utf8'), fixture.desiredContent);
        assert.ok(!binEntries.some((entry) => entry.endsWith('.tmp')), 'temp launcher files must be cleaned up');
        assert.ok(!binEntries.includes('.garda-cli-sync.lock'), 'lock directory must be removed after sync');
    } finally {
        fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
    }
});
