import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildDomainScopeFingerprints,
    getReviewLaneScopeSha256
} from '../../../../src/gates/scope/domain-scope-fingerprints';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint
} from '../../../../src/gates/review-reuse';
import { getClassificationConfig } from '../../../../src/gates/preflight/classify-change';

type GitHelpersModule = typeof import('../../../../src/core/git-helpers');

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(result.status, 0, String(result.stderr || result.error || 'git command failed'));
}

describe('gates/domain-scope-fingerprints', () => {
    it('shares one staged-index read across domain and legacy fingerprints', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-domain-scope-staged-batch-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            const changedFiles = Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`);
            for (const changedFile of changedFiles) {
                fs.writeFileSync(path.join(repoRoot, changedFile), `export const source = "${changedFile}";\n`, 'utf8');
            }
            runGit(repoRoot, ['add', 'src']);

            const requireForPatch = createRequire(__filename);
            const gitHelpers = requireForPatch('../../../../src/core/git-helpers') as {
                runGitBinary: GitHelpersModule['runGitBinary'];
            };
            const originalRunGitBinary = gitHelpers.runGitBinary;
            let stagedIndexReadCount = 0;
            let fingerprints: ReturnType<typeof buildDomainScopeFingerprints> | null = null;
            try {
                gitHelpers.runGitBinary = ((root, args, options) => {
                    if (args[0] === 'ls-files' && args.includes('--stage') && args.includes('-z')) {
                        stagedIndexReadCount += 1;
                    }
                    return originalRunGitBinary(root, args, options);
                }) as GitHelpersModule['runGitBinary'];
                fingerprints = buildDomainScopeFingerprints({
                    repoRoot,
                    detectionSource: 'git_staged_only',
                    includeUntracked: false,
                    changedFiles
                });
            } finally {
                gitHelpers.runGitBinary = originalRunGitBinary;
            }

            assert.equal(stagedIndexReadCount, 1);
            assert.ok(fingerprints);
            assert.equal(fingerprints.domains.implementation.changed_files_count, changedFiles.length);
            assert.match(fingerprints.domains.implementation.scope_content_sha256 || '', /^[0-9a-f]{64}$/u);
            assert.match(fingerprints.legacy.review_scope_sha256 || '', /^[0-9a-f]{64}$/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves legacy closeout-aware review scope hashes', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-domain-scope-closeout-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, '.agents'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'TASK.md'), '# Task queue\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, '.agents', 'notes.md'), '# Notes\n', 'utf8');

            const preflight = {
                detection_source: 'explicit_changed_files',
                include_untracked: true,
                changed_files: ['src/app.ts', 'TASK.md', '.agents/notes.md']
            };

            const fingerprints = buildDomainScopeFingerprints({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: preflight.changed_files
            });

            assert.equal(
                fingerprints.legacy.review_scope_sha256,
                computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256
            );
            assert.equal(
                getReviewLaneScopeSha256('code', fingerprints),
                computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot).code_scope_sha256
            );
            assert.equal(
                getReviewLaneScopeSha256('security', fingerprints),
                computeReviewReuseCodeScopeFingerprint('security', preflight, repoRoot).code_scope_sha256
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps code-like protected control-plane files in the implementation domain', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-domain-scope-protected-code-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src', 'gates'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'gates', 'review-tree-state.ts'),
                'export const gate = "alpha";\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
                '{\"enabled\":true}\n',
                'utf8'
            );

            const fingerprints = buildDomainScopeFingerprints({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: [
                    'src/gates/review-tree-state.ts',
                    'garda-agent-orchestrator/live/config/workflow-config.json'
                ]
            });

            assert.deepEqual(
                fingerprints.domains.implementation.changed_files,
                ['src/gates/review-tree-state.ts']
            );
            assert.deepEqual(
                fingerprints.domains.config.changed_files,
                ['garda-agent-orchestrator/live/config/workflow-config.json']
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects mutable classification drift across domain and legacy review hashes', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-domain-scope-locked-config-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'custom-specs'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'custom-notes'), { recursive: true });
            fs.writeFileSync(
                path.join(repoRoot, 'custom-specs', 'classification-case.ts'),
                'export const classificationCase = true;\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(repoRoot, 'custom-notes', 'classification-guide'),
                'classification guide\n',
                'utf8'
            );

            const mutableConfig = getClassificationConfig(repoRoot);
            const lockedConfig = {
                ...mutableConfig,
                source: 'task_profile_policy_snapshot',
                test_trigger_regexes: ['(^|/)custom-specs/'],
                ordinary_doc_paths: ['custom-notes/classification-guide']
            };
            const preflight = {
                detection_source: 'explicit_changed_files',
                include_untracked: true,
                changed_files: [
                    'custom-specs/classification-case.ts',
                    'custom-notes/classification-guide'
                ]
            };

            const fingerprints = buildDomainScopeFingerprints({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: preflight.changed_files,
                classificationConfig: lockedConfig
            });
            const lockedReviewScope = computeReviewRelevantScopeFingerprint(
                preflight,
                repoRoot,
                lockedConfig
            );
            const lockedCodeScope = computeReviewReuseCodeScopeFingerprint(
                'code',
                preflight,
                repoRoot,
                lockedConfig
            );

            assert.deepEqual(
                fingerprints.domains.test.changed_files,
                ['custom-specs/classification-case.ts']
            );
            assert.deepEqual(
                fingerprints.domains.docs.changed_files,
                ['custom-notes/classification-guide']
            );
            assert.deepEqual(fingerprints.domains.implementation.changed_files, []);
            assert.equal(fingerprints.legacy.review_scope_sha256, lockedReviewScope.review_scope_sha256);
            assert.equal(fingerprints.legacy.code_review_scope_sha256, lockedCodeScope.code_scope_sha256);
            assert.equal(fingerprints.legacy.non_test_review_scope_sha256, lockedCodeScope.code_scope_sha256);
            assert.notEqual(
                lockedReviewScope.review_scope_sha256,
                computeReviewRelevantScopeFingerprint(preflight, repoRoot, mutableConfig).review_scope_sha256
            );
            assert.notEqual(
                lockedCodeScope.code_scope_sha256,
                computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot, mutableConfig).code_scope_sha256
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps code-review lane narrower than performance-review lane for perf support files', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-domain-scope-perf-lanes-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'apps', 'shop', 'perf'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const app = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const perf = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'apps', 'shop', 'perf', 'cache.ts'), 'export const cache = "alpha";\n', 'utf8');

            const preflight = {
                detection_source: 'explicit_changed_files',
                include_untracked: true,
                changed_files: ['src/app.ts', 'benchmark/reviewed.ts', 'apps/shop/perf/cache.ts']
            };

            const fingerprints = buildDomainScopeFingerprints({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: preflight.changed_files
            });
            const expectedCodeLane = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot).code_scope_sha256;
            const expectedPerformanceLane = computeReviewReuseCodeScopeFingerprint(
                'performance',
                preflight,
                repoRoot
            ).code_scope_sha256;

            assert.equal(getReviewLaneScopeSha256('code', fingerprints), expectedCodeLane);
            assert.equal(getReviewLaneScopeSha256('performance', fingerprints), expectedPerformanceLane);
            assert.notEqual(
                getReviewLaneScopeSha256('code', fingerprints),
                getReviewLaneScopeSha256('performance', fingerprints)
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
