import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

function collectMatchingFiles(rootPath: string, extension: string): string[] {
    if (!fs.existsSync(rootPath)) {
        return [];
    }

    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    const matches: string[] = [];

    for (const entry of entries) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            matches.push(...collectMatchingFiles(entryPath, extension));
            continue;
        }

        if (entry.isFile() && entry.name.endsWith(extension)) {
            matches.push(entryPath);
        }
    }

    return matches.sort();
}

function collectStaleJsFiles(distSrcDir: string, srcDir: string): string[] {
    const distJsFiles = collectMatchingFiles(distSrcDir, '.js');
    const staleFiles: string[] = [];

    for (const distFile of distJsFiles) {
        const relativePath = path.relative(distSrcDir, distFile);
        const normalizedPath = relativePath.split(path.sep).join('/');
        if (normalizedPath === 'core/vendor-typescript.js') {
            continue;
        }
        const expectedSourcePath = path.join(srcDir, relativePath.replace(/\.js$/, '.ts'));

        if (!fs.existsSync(expectedSourcePath)) {
            staleFiles.push(normalizedPath);
        }
    }

    return staleFiles;
}

test('dist directory does not contain stale JS files from renamed or deleted source files', () => {
    const repoRoot = getRepoRoot();
    const distSrcDir = path.join(repoRoot, 'dist', 'src');
    const srcDir = path.join(repoRoot, 'src');

    if (!fs.existsSync(distSrcDir)) {
        return;
    }

    const parserRoot = path.join(repoRoot, 'node_modules', 'typescript');
    const notices = ['LICENSE.txt', 'ThirdPartyNoticeText.txt']
        .map(filename => fs.readFileSync(path.join(parserRoot, filename), 'utf8'))
        .join('\n');
    const expectedParser = fs.readFileSync(path.join(parserRoot, 'lib', 'typescript.js'), 'utf8')
        + '\n' + notices.split(/\r?\n/u).map(line => `// ${line}`).join('\n') + '\n';
    const actualParser = fs.readFileSync(path.join(distSrcDir, 'core', 'vendor-typescript.js'));
    assert.equal(
        createHash('sha256').update(actualParser).digest('hex'),
        createHash('sha256').update(expectedParser).digest('hex'),
        'Declared generated parser must match the installed parser and its license notices'
    );
    assert.deepEqual(collectStaleJsFiles(distSrcDir, srcDir), [],
        'Found stale generated JS files without a maintained source or declared generated-parser contract');
});

test('regression: renamed source module leaving an obsolete generated JS file is caught', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stale-dist-regression-'));
    const distSrcDir = path.join(tempRoot, 'dist', 'src');
    const srcDir = path.join(tempRoot, 'src');

    // Keep the regression fixture isolated from the real dist tree because the full suite runs files concurrently.
    const fakeStaleRelativePath = path.join('core', 'stale-regression-test-fake.js');
    const fakeStalePath = path.join(distSrcDir, fakeStaleRelativePath);

    fs.mkdirSync(path.dirname(fakeStalePath), { recursive: true });
    fs.writeFileSync(fakeStalePath, 'console.log("stale");', 'utf8');

    try {
        const staleFiles = collectStaleJsFiles(distSrcDir, srcDir);

        const normalizedFakeStaleRelativePath = fakeStaleRelativePath.split(path.sep).join('/');
        assert.ok(
            staleFiles.includes(normalizedFakeStaleRelativePath),
            'The stale checking logic must catch a deliberately placed obsolete JS file'
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
