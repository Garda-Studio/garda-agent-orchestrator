import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const scriptPath = path.resolve(process.cwd(), 'scripts/release-candidate.cjs');
const commit = 'a'.repeat(40);
const repository = 'Garda-Studio/garda-agent-orchestrator';

function runCandidate(args: string[]): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync(process.execPath, [scriptPath, ...args], {
        encoding: 'utf8',
        windowsHide: true
    });
}

function createTarFixture(): { root: string; directory: string; reportPath: string; tarballPath: string; outputPath: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-candidate-'));
    const directory = path.join(root, 'candidate');
    const packageDirectory = path.join(root, 'package');
    fs.mkdirSync(directory);
    fs.mkdirSync(packageDirectory);
    const packageJson = '{"name":"garda-agent-orchestrator","version":"1.2.3"}\n';
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), packageJson);
    const tarballPath = path.join(directory, 'garda-agent-orchestrator-1.2.3.tgz');
    const tar = childProcess.spawnSync('tar', ['-C', root, '-czf', tarballPath, 'package'], {
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(tar.status, 0, tar.stderr);
    const reportPath = path.join(directory, 'pack-report.json');
    fs.writeFileSync(reportPath, JSON.stringify([{
        name: 'garda-agent-orchestrator',
        version: '1.2.3',
        filename: path.basename(tarballPath),
        size: fs.statSync(tarballPath).size,
        entryCount: 1,
        unpackedSize: Buffer.byteLength(packageJson),
        files: [{ path: 'package.json', size: Buffer.byteLength(packageJson) }]
    }]));
    return { root, directory, reportPath, tarballPath, outputPath: path.join(root, 'github-output.txt') };
}

test('release CI proof accepts only a successful branch push for the exact commit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-ci-proof-'));
    try {
        const evidencePath = path.join(root, 'runs.json');
        const matchingRun = {
            head_sha: commit,
            repository: { full_name: repository },
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            head_branch: 'dev'
        };
        fs.writeFileSync(evidencePath, JSON.stringify({ workflow_runs: [matchingRun] }));
        assert.equal(runCandidate(['verify-ci', evidencePath, commit, repository]).status, 0);
        for (const wrongRun of [
            { ...matchingRun, head_sha: 'b'.repeat(40) },
            { ...matchingRun, conclusion: 'failure' },
            { ...matchingRun, event: 'pull_request' },
            { ...matchingRun, repository: { full_name: 'foreign/repo' } },
            { ...matchingRun, head_branch: 'feature' }
        ]) {
            fs.writeFileSync(evidencePath, JSON.stringify({ workflow_runs: [wrongRun] }));
            const result = runCandidate(['verify-ci', evidencePath, commit, repository]);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /No successful branch-push CI run/u);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('release candidate manifest binds the exact tarball, commit, and npm pack file list', () => {
    const fixture = createTarFixture();
    try {
        const create = runCandidate([
            'create', fixture.reportPath, fixture.directory, commit, 'v1.2.3',
            'garda-agent-orchestrator', '1.2.3', fixture.outputPath
        ]);
        assert.equal(create.status, 0, create.stderr);
        const manifest = JSON.parse(fs.readFileSync(path.join(fixture.directory, 'candidate-manifest.json'), 'utf8')) as {
            tarball_sha256: string;
            tarball_name: string;
            files: Array<{ path: string; size: number }>;
        };
        assert.deepEqual(manifest.files, [{ path: 'package.json', size: 54 }]);
        assert.match(fs.readFileSync(fixture.outputPath, 'utf8'), /tarball_sha256=[a-f0-9]{64}/u);
        const verifyArgs = ['verify', fixture.directory, commit, 'v1.2.3', manifest.tarball_sha256, manifest.tarball_name];
        assert.equal(runCandidate(verifyArgs).status, 0);
        assert.notEqual(runCandidate(['verify', fixture.directory, 'b'.repeat(40), 'v1.2.3',
            manifest.tarball_sha256, manifest.tarball_name]).status, 0);
        fs.appendFileSync(fixture.tarballPath, 'tampered');
        const changed = runCandidate(verifyArgs);
        assert.notEqual(changed.status, 0);
        assert.match(changed.stderr, /digest or size changed/u);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('release candidate creation rejects a dishonest or unsafe npm pack report', () => {
    const fixture = createTarFixture();
    try {
        const report = JSON.parse(fs.readFileSync(fixture.reportPath, 'utf8')) as Array<Record<string, unknown>>;
        for (const change of [
            { files: [{ path: '../outside', size: 52 }] },
            { filename: '../outside.tgz' },
            { entryCount: 0 },
            { version: '1.2.4' }
        ]) {
            fs.writeFileSync(fixture.reportPath, JSON.stringify([{ ...report[0], ...change }]));
            const result = runCandidate([
                'create', fixture.reportPath, fixture.directory, commit, 'v1.2.3',
                'garda-agent-orchestrator', '1.2.3', fixture.outputPath
            ]);
            assert.notEqual(result.status, 0);
            assert.equal(fs.existsSync(path.join(fixture.directory, 'candidate-manifest.json')), false);
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});
