import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { readExistingRulePackArtifact, resolveRulePackArtifactPath } from '../../../../src/gates/rule-pack/rule-pack-artifact-store';

function createTempDirectory(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('resolveRulePackArtifactPath', () => {
    it('uses the task-owned default path', () => {
        const repoRoot = createTempDirectory('garda-rule-pack-repo-');
        try {
            fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator'));
            assert.equal(resolveRulePackArtifactPath(repoRoot, 'T-924-2', ''),
                path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-924-2-rule-pack.json'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('resolves a missing relative artifact path inside the repository', () => {
        const repoRoot = createTempDirectory('garda-rule-pack-repo-');
        try {
            const resolvedPath = resolveRulePackArtifactPath(
                repoRoot,
                'T-924-2',
                path.join('runtime', 'reviews', 'custom-rule-pack.json')
            );

            assert.equal(
                resolvedPath,
                path.join(repoRoot, 'runtime', 'reviews', 'custom-rule-pack.json')
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects an absolute artifact path outside the repository', () => {
        const repoRoot = createTempDirectory('garda-rule-pack-repo-');
        const outsideRoot = createTempDirectory('garda-rule-pack-outside-');
        try {
            assert.throws(
                () => resolveRulePackArtifactPath(
                    repoRoot,
                    'T-924-2',
                    path.join(outsideRoot, 'rule-pack.json')
                ),
                /Path must resolve inside repo root without symlink or junction escapes/u
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it('rejects a repo-local symlink or junction that resolves outside the repository', (t) => {
        const repoRoot = createTempDirectory('garda-rule-pack-repo-');
        const outsideRoot = createTempDirectory('garda-rule-pack-outside-');
        const linkedDirectory = path.join(repoRoot, 'linked-reviews');
        try {
            try {
                fs.symlinkSync(outsideRoot, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                t.skip(
                    `directory symlink creation unavailable in this environment: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
                return;
            }

            assert.throws(
                () => resolveRulePackArtifactPath(
                    repoRoot,
                    'T-924-2',
                    path.join('linked-reviews', 'rule-pack.json')
                ),
                /must resolve inside repo root without symlink or junction escape/
            );
            assert.equal(fs.existsSync(path.join(outsideRoot, 'rule-pack.json')), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });
});

describe('readExistingRulePackArtifact', () => {
    it('accepts a stage-bearing artifact and rejects missing or malformed storage', () => {
        const repoRoot = createTempDirectory('garda-rule-pack-store-');
        const artifactPath = path.join(repoRoot, 'rule-pack.json');
        try {
            assert.equal(readExistingRulePackArtifact(artifactPath), null);
            fs.writeFileSync(artifactPath, '{', 'utf8');
            assert.equal(readExistingRulePackArtifact(artifactPath), null);
            fs.writeFileSync(artifactPath, JSON.stringify({ task_id: 'T-924-2' }), 'utf8');
            assert.equal(readExistingRulePackArtifact(artifactPath), null);
            fs.writeFileSync(artifactPath, JSON.stringify({ task_id: 'T-924-2', stages: {} }), 'utf8');
            assert.equal(readExistingRulePackArtifact(artifactPath)?.task_id, 'T-924-2');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
