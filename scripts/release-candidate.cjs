#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SHA256_RE = /^[a-f0-9]{64}$/u;
const COMMIT_RE = /^[a-f0-9]{40}$/u;
const RELEASE_BRANCHES = new Set(['dev', 'main', 'master']);

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertRegularFile(filePath) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Release candidate must be a regular file: ' + filePath);
    }
    return stat;
}

function assertSafeName(name) {
    if (typeof name !== 'string' || !name.endsWith('.tgz') || path.basename(name) !== name ||
        name === '.' || name === '..' || name.includes('\\') || name.includes('/') || name.includes('\0')) {
        throw new Error('Unsafe release tarball name.');
    }
    return name;
}

function assertCommit(value) {
    if (!COMMIT_RE.test(value || '')) {
        throw new Error('Release commit must be a full lowercase SHA.');
    }
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    try {
        for (;;) {
            const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (bytesRead === 0) {
                break;
            }
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(descriptor);
    }
    return hash.digest('hex');
}

function tarFilePaths(tarballPath) {
    const result = childProcess.spawnSync('tar', ['-tzf', tarballPath], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.error || result.status !== 0) {
        throw new Error('Release tarball cannot be listed: ' + String(result.error?.message || result.stderr).trim());
    }
    const paths = result.stdout.split(/\r?\n/u).filter(Boolean)
        .filter((entry) => !entry.endsWith('/'))
        .map((entry) => {
            if (!entry.startsWith('package/')) {
                throw new Error('Release tarball has an unexpected root entry.');
            }
            const relative = entry.slice('package/'.length);
            if (!relative || relative.startsWith('/') || relative.includes('\\') ||
                relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
                throw new Error('Release tarball has an unsafe entry.');
            }
            return relative;
        });
    if (paths.length === 0 || new Set(paths).size !== paths.length) {
        throw new Error('Release tarball has no files or duplicate paths.');
    }
    return paths.sort();
}

function reportFiles(report) {
    if (!Array.isArray(report.files) || report.files.length === 0) {
        throw new Error('npm pack report has no files.');
    }
    const files = report.files.map((file) => {
        if (typeof file?.path !== 'string' || !file.path ||
            file.path.startsWith('/') || file.path.includes('\\') ||
            file.path.split('/').some((segment) => !segment || segment === '.' || segment === '..') ||
            !Number.isSafeInteger(file.size) || file.size < 0) {
            throw new Error('npm pack report contains an invalid file.');
        }
        return { path: file.path, size: file.size };
    }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
    if (new Set(files.map((file) => file.path)).size !== files.length) {
        throw new Error('npm pack report contains duplicate files.');
    }
    return files;
}

function verifyCiRuns(payload, commit, repository) {
    assertCommit(commit);
    if (!repository || typeof repository !== 'string' || !Array.isArray(payload?.workflow_runs)) {
        throw new Error('CI workflow-run evidence is unavailable.');
    }
    const passing = payload.workflow_runs.some((run) =>
        run?.head_sha === commit &&
        run?.repository?.full_name === repository &&
        run?.event === 'push' &&
        run?.status === 'completed' &&
        run?.conclusion === 'success' &&
        RELEASE_BRANCHES.has(run?.head_branch)
    );
    if (!passing) {
        throw new Error('No successful branch-push CI run for the exact release commit.');
    }
}

function createManifest(reportPayload, directory, commit, tag, expectedName, expectedVersion) {
    assertCommit(commit);
    if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(tag || '') ||
        !Array.isArray(reportPayload) || reportPayload.length !== 1) {
        throw new Error('Release tag or npm pack report is invalid.');
    }
    const report = reportPayload[0];
    if (report?.name !== expectedName || report?.version !== expectedVersion ||
        tag.slice(1) !== expectedVersion) {
        throw new Error('npm pack identity differs from release tag/package.');
    }
    const tarballName = assertSafeName(report.filename);
    const tarballPath = path.join(directory, tarballName);
    const stat = assertRegularFile(tarballPath);
    if (!Number.isSafeInteger(report.size) || stat.size !== report.size || stat.size <= 0) {
        throw new Error('npm pack tarball size differs from report.');
    }
    const files = reportFiles(report);
    if (report.entryCount !== files.length ||
        report.unpackedSize !== files.reduce((sum, file) => sum + file.size, 0)) {
        throw new Error('npm pack file count or unpacked size differs from report.');
    }
    const archivedPaths = tarFilePaths(tarballPath);
    if (JSON.stringify(archivedPaths) !== JSON.stringify(files.map((file) => file.path).sort())) {
        throw new Error('Release tarball entries differ from npm pack manifest.');
    }
    return {
        schema_version: 1,
        commit_sha: commit,
        tag,
        package_name: expectedName,
        package_version: expectedVersion,
        tarball_name: tarballName,
        tarball_sha256: sha256File(tarballPath),
        tarball_size: stat.size,
        files
    };
}

function verifyManifest(directory, commit, tag, expectedSha256, expectedName) {
    assertCommit(commit);
    if (!SHA256_RE.test(expectedSha256 || '')) {
        throw new Error('Expected release tarball digest is invalid.');
    }
    const manifest = readJson(path.join(directory, 'candidate-manifest.json'));
    if (manifest?.schema_version !== 1 || manifest.commit_sha !== commit || manifest.tag !== tag ||
        manifest.tarball_sha256 !== expectedSha256 || manifest.tarball_name !== expectedName ||
        manifest.package_version !== tag.slice(1) || manifest.package_name !== 'garda-agent-orchestrator') {
        throw new Error('Release candidate manifest does not match the validated job output.');
    }
    const tarballName = assertSafeName(manifest.tarball_name);
    const tarballPath = path.join(directory, tarballName);
    const stat = assertRegularFile(tarballPath);
    if (stat.size !== manifest.tarball_size || sha256File(tarballPath) !== expectedSha256) {
        throw new Error('Release candidate tarball digest or size changed after validation.');
    }
    const files = reportFiles(manifest);
    if (JSON.stringify(tarFilePaths(tarballPath)) !== JSON.stringify(files.map((file) => file.path).sort())) {
        throw new Error('Release candidate tarball entries differ from manifest.');
    }
    return tarballPath;
}

function main(argv) {
    const [command, ...args] = argv;
    if (command === 'verify-ci' && args.length === 3) {
        verifyCiRuns(readJson(args[0]), args[1], args[2]);
        process.stdout.write('RELEASE_CI_COMMIT_VERIFIED\n');
        return;
    }
    if (command === 'create' && args.length === 7) {
        const [reportPath, directory, commit, tag, name, version, outputPath] = args;
        const manifest = createManifest(readJson(reportPath), directory, commit, tag, name, version);
        fs.writeFileSync(path.join(directory, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        fs.appendFileSync(outputPath, 'tarball_sha256=' + manifest.tarball_sha256 + '\n' +
            'tarball_name=' + manifest.tarball_name + '\n');
        process.stdout.write('RELEASE_CANDIDATE_MANIFEST_CREATED\n');
        return;
    }
    if (command === 'verify' && args.length === 5) {
        const tarballPath = verifyManifest(args[0], args[1], args[2], args[3], args[4]);
        process.stdout.write('RELEASE_CANDIDATE_VERIFIED ' + tarballPath + '\n');
        return;
    }
    throw new Error('Usage: release-candidate.cjs <verify-ci|create|verify> <arguments>');
}

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { createManifest, verifyCiRuns, verifyManifest };
