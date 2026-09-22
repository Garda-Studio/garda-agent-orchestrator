import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';

import {
    CLI_PATH_INPUT_POLICIES,
    getCliPathInputPolicy,
    isPathShapedCliFlag,
    validateParsedCliPathInputs
} from '../../../src/core/cli-path-input-policy';
import { resolvePathInsideRepo } from '../../../src/core/orchestrator-paths';
import { parseOptions } from '../../../src/cli/commands/cli-parsing';
import { resolveOutputPath } from '../../../src/gates/preflight/build-scoped-diff';
import { COMPACT_CLI_OPTIONS } from '../../../src/core/compact/setting-definitions';

const OPTION_PATTERN = /['"](--[a-z0-9-]*(?:path|file|dir|root)[a-z0-9-]*|--chdir)['"]/gu;

function collectTypeScriptFiles(directoryPath: string): string[] {
    const result: string[] = [];
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            result.push(...collectTypeScriptFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            result.push(entryPath);
        }
    }
    return result;
}

function collectPathShapedCliFlags(repoRoot: string): string[] {
    const flags = new Set<string>();
    for (const sourceRoot of ['src/cli', 'src/bin']) {
        for (const filePath of collectTypeScriptFiles(path.join(repoRoot, sourceRoot))) {
            const content = fs.readFileSync(filePath, 'utf8');
            for (const match of content.matchAll(OPTION_PATTERN)) {
                if (isPathShapedCliFlag(match[1])) {
                    flags.add(match[1]);
                }
            }
        }
    }
    for (const flagName of Object.keys(COMPACT_CLI_OPTIONS)) {
        if (isPathShapedCliFlag(flagName)) {
            flags.add(flagName);
        }
    }
    return [...flags].sort();
}

function resolveRepoRoot(startPath: string): string {
    let currentPath = path.resolve(startPath);
    while (true) {
        if (
            fs.existsSync(path.join(currentPath, 'package.json'))
            && fs.existsSync(path.join(currentPath, 'src', 'cli'))
        ) {
            return currentPath;
        }
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            throw new Error(`Could not resolve repository root from ${startPath}`);
        }
        currentPath = parentPath;
    }
}

function createDirectoryLink(t: TestContext, targetPath: string, linkPath: string): boolean {
    try {
        fs.symlinkSync(
            targetPath,
            linkPath,
            process.platform === 'win32' ? 'junction' : 'dir'
        );
        return true;
    } catch (error: unknown) {
        const code = String((error as NodeJS.ErrnoException)?.code || '');
        if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code)) {
            t.skip(`filesystem links unavailable: ${code}`);
            return false;
        }
        throw error;
    }
}

test('every path-shaped CLI flag has an explicit policy classification', () => {
    const repoRoot = resolveRepoRoot(__dirname);
    const discoveredFlags = collectPathShapedCliFlags(repoRoot);
    const unclassifiedFlags = discoveredFlags.filter((flagName) => !getCliPathInputPolicy(flagName));
    assert.deepEqual(unclassifiedFlags, []);
    assert.deepEqual(Object.keys(CLI_PATH_INPUT_POLICIES).sort(), discoveredFlags);
});

test('workspace-contained inputs allow an in-root existing path and missing descendant', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-root-'));
    try {
        fs.mkdirSync(path.join(repoRoot, 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'runtime', 'preflight.json'), '{}\n', 'utf8');
        const definitions = {
            '--repo-root': { key: 'repoRoot', type: 'string' },
            '--preflight-path': { key: 'preflightPath', type: 'string' },
            '--artifact-path': { key: 'artifactPath', type: 'string' }
        };
        assert.doesNotThrow(() => validateParsedCliPathInputs(definitions, {
            repoRoot,
            preflightPath: 'runtime/preflight.json',
            artifactPath: 'runtime/future/artifact.json'
        }));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('workspace-contained inputs allow an absolute in-root POSIX path on POSIX', {
    skip: process.platform === 'win32'
}, () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-root-'));
    const artifactPath = path.join(repoRoot, 'runtime', 'artifact.json');
    try {
        assert.doesNotThrow(() => validateParsedCliPathInputs({
            '--repo-root': { key: 'repoRoot', type: 'string' },
            '--artifact-path': { key: 'artifactPath', type: 'string' }
        }, {
            repoRoot,
            artifactPath
        }));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('workspace-contained inputs reject Windows-only absolute paths on POSIX', {
    skip: process.platform === 'win32'
}, () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-root-'));
    try {
        assert.throws(() => validateParsedCliPathInputs({
            '--repo-root': { key: 'repoRoot', type: 'string' },
            '--artifact-path': { key: 'artifactPath', type: 'string' }
        }, {
            repoRoot,
            artifactPath: 'C:\\outside\\artifact.json'
        }), /must resolve inside workspace root/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('foreign workspace-contained inputs reject relative traversal and absolute outside paths', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-root-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-outside-'));
    const definitions = {
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--changed-files': { key: 'changedFiles', type: 'string[]' }
    };
    try {
        assert.throws(
            () => validateParsedCliPathInputs(definitions, {
                repoRoot,
                artifactPath: '../outside.json'
            }),
            /must resolve inside workspace root/u
        );
        assert.throws(
            () => validateParsedCliPathInputs(definitions, {
                repoRoot,
                artifactPath: path.join(outsideRoot, 'outside.json')
            }),
            /must resolve inside workspace root/u
        );
        assert.throws(
            () => validateParsedCliPathInputs(definitions, {
                repoRoot,
                changedFiles: ['src/inside.ts,../outside.ts']
            }),
            /must resolve inside workspace root/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('foreign parseOptions input enforces workspace containment at the CLI boundary', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-root-'));
    const definitions = {
        '--repo-root': { key: 'repoRoot', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' }
    };
    try {
        assert.throws(
            () => parseOptions([
                '--repo-root',
                repoRoot,
                '--artifact-path',
                '../outside.json'
            ], definitions),
            /must resolve inside workspace root/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('replaced workspace-contained inputs reject repo-local symlink or junction escapes', (t) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-root-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-outside-'));
    try {
        if (!createDirectoryLink(t, outsideRoot, path.join(repoRoot, 'linked'))) {
            return;
        }
        assert.throws(
            () => validateParsedCliPathInputs({
                '--repo-root': { key: 'repoRoot', type: 'string' },
                '--answers-path': { key: 'answersPath', type: 'string' }
            }, {
                repoRoot,
                answersPath: 'linked/answers.json'
            }),
            /symlink or junction escapes/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('intentionally external and contextual paths remain explicitly exempt', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-root-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-outside-'));
    try {
        assert.doesNotThrow(() => validateParsedCliPathInputs({
            '--repo-root': { key: 'repoRoot', type: 'string' },
            '--source-path': { key: 'sourcePath', type: 'string' },
            '--snapshot-path': { key: 'snapshotPath', type: 'string' },
            '--output-path': { key: 'outputPath', type: 'string' }
        }, {
            repoRoot,
            sourcePath: path.join(outsideRoot, 'bundle'),
            snapshotPath: path.join(outsideRoot, 'snapshot'),
            outputPath: path.join(outsideRoot, 'report.html')
        }));
        assert.equal(getCliPathInputPolicy('--source-path')?.classification, 'external-allowed');
        assert.equal(getCliPathInputPolicy('--snapshot-path')?.classification, 'external-allowed');
        assert.equal(getCliPathInputPolicy('--output-path')?.classification, 'contextual');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('foreign contextual gate output keeps the owning command repository-contained', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-root-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-outside-'));
    try {
        const preflightPath = path.join(repoRoot, 'runtime', 'reviews', 'T-939-preflight.json');
        assert.throws(
            () => resolveOutputPath(
                path.join(outsideRoot, 'T-939-test-scoped.diff'),
                preflightPath,
                'test',
                repoRoot
            ),
            /must resolve inside repo root/u
        );
        assert.equal(
            resolveOutputPath(
                path.join(repoRoot, 'runtime', 'reviews', 'T-939-test-scoped.diff'),
                preflightPath,
                'test',
                repoRoot
            ),
            path.join(repoRoot, 'runtime', 'reviews', 'T-939-test-scoped.diff')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('direct repository resolver rejects a repo-local link escape for a missing output', (t) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repo-path-root-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repo-path-outside-'));
    try {
        if (!createDirectoryLink(t, outsideRoot, path.join(repoRoot, 'linked'))) {
            return;
        }
        assert.throws(
            () => resolvePathInsideRepo('linked/missing-output.json', repoRoot, {
                allowMissing: true
            }),
            /symlink or junction escapes/u
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('foreign external exceptions do not exempt a workspace-contained artifact path', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-root-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-path-outside-'));
    try {
        assert.throws(() => validateParsedCliPathInputs({
            '--repo-root': { key: 'repoRoot', type: 'string' },
            '--source-path': { key: 'sourcePath', type: 'string' },
            '--artifact-path': { key: 'artifactPath', type: 'string' }
        }, {
            repoRoot,
            sourcePath: path.join(outsideRoot, 'bundle'),
            artifactPath: path.join(outsideRoot, 'artifact.json')
        }), /must resolve inside workspace root/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('missing unknown path-shaped flags fail closed', () => {
    assert.throws(
        () => validateParsedCliPathInputs({
            '--future-secret-path': { key: 'futureSecretPath', type: 'string' }
        }, {
            futureSecretPath: 'runtime/secret.json'
        }),
        /Unclassified CLI path input/u
    );
});
