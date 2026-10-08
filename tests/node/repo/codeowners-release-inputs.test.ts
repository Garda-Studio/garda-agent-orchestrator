import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

interface OwnershipMatch {
    file: string;
    pattern: string;
    owners: string[];
}

function matchOwnership(content: string, files: string[]): OwnershipMatch[] {
    const rules = content.split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
            const [pattern, ...owners] = line.split(/\s+/u);
            assert.doesNotMatch(pattern, /^[!#]|[\\\[\]]/u, 'Use the Git-compatible CODEOWNERS pattern subset');
            assert.ok(owners.length > 0, `Missing owners for ${pattern}`);
            return { pattern, owners };
        });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-codeowners-'));
    const matches = files.map((file): OwnershipMatch => ({ file, pattern: '', owners: [] }));
    try {
        const init = childProcess.spawnSync('git', ['-c', 'init.templateDir=', 'init', '--quiet'], {
            cwd: projectRoot, encoding: 'utf8', windowsHide: true
        });
        assert.equal(init.status, 0, init.stderr || String(init.error || 'git init failed'));
        // Match each rule separately: gitignore's excluded-parent pruning is not CODEOWNERS precedence.
        for (const rule of rules) {
            fs.writeFileSync(path.join(projectRoot, '.gitignore'), rule.pattern + '\n');
            const result = childProcess.spawnSync('git', [
                '-c', 'core.excludesFile=', 'check-ignore', '--no-index', '--verbose', '--non-matching', '--stdin', '-z'
            ], { cwd: projectRoot, input: files.join('\0') + '\0', encoding: 'utf8', windowsHide: true });
            assert.ok(result.status === 0 || result.status === 1, result.stderr || String(result.error));
            const fields = result.stdout.split('\0');
            assert.equal(fields.pop(), '');
            assert.equal(fields.length, files.length * 4);
            files.forEach((file, index) => {
                const [source, line, pattern, matchedFile] = fields.slice(index * 4, index * 4 + 4);
                assert.equal(matchedFile, file);
                if (line) {
                    assert.equal(source, '.gitignore');
                    assert.equal(line, '1');
                    assert.equal(pattern, rule.pattern);
                    matches[index] = { file, pattern, owners: rule.owners };
                }
            });
        }
        return matches;
    } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
    }
}

function readCodeowners(): string {
    return fs.readFileSync(path.join(getRepoRoot(), '.github', 'CODEOWNERS'), 'utf8');
}

test('release inputs resolve to explicit existing maintainer ownership', () => {
    const expectedPatterns = new Map([
        ['scripts/node-foundation/build.ts', '/scripts/**'],
        ['scripts/node-foundation/release-validation/readiness.ts', '/scripts/**'],
        ['config/release-package-surface-baseline.json', '/config/release-package-surface-baseline.json'],
        ['VERSION', '/VERSION'],
        ['.github/CODEOWNERS', '/.github/CODEOWNERS'],
        ['docs/release-readiness.md', '/docs/release-readiness.md']
    ]);
    for (const match of matchOwnership(readCodeowners(), [...expectedPatterns.keys()])) {
        assert.equal(match.pattern, expectedPatterns.get(match.file), match.file);
        assert.deepEqual(match.owners, ['@Shubchynskyi'], match.file);
    }
    for (const match of matchOwnership(readCodeowners(), ['src/cli/main.ts', '.github/workflows/publish.yml'])) {
        assert.deepEqual(match.owners, ['@Shubchynskyi'], match.file);
    }
});

test('release ownership patterns stay rooted and exclude similar filenames', () => {
    const files = [
        'vendor/scripts/node-foundation/build.ts',
        'vendor/config/release-package-surface-baseline.json',
        'vendor/VERSION',
        'vendor/.github/CODEOWNERS',
        'vendor/docs/release-readiness.md',
        'config/release-package-surface-baseline.json.backup',
        'docs/release-readiness.md.backup'
    ];
    for (const match of matchOwnership(readCodeowners(), files)) {
        assert.equal(match.pattern, '', match.file);
        assert.deepEqual(match.owners, [], match.file);
    }
});

test('native ownership matching uses the last matching rule', () => {
    const file = 'scripts/node-foundation/build.ts';
    const broad = '/scripts/** @Shubchynskyi';
    const specific = `/${file} @Shubchynskyi`;
    assert.equal(matchOwnership(`${broad}\n${specific}\n`, [file])[0].pattern, `/${file}`);
    assert.equal(matchOwnership(`${specific}\n${broad}\n`, [file])[0].pattern, '/scripts/**');
});
