import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash,
    computeSchema3ReviewContextReuseCompatibilityHash,
    computeReviewRuleContextReuseHash,
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    getReviewContextReuseContractBindingMismatch,
    resolveReviewContextReuseContractBindings,
    resolveReviewReceiptReuseContractBindings
} from '../../../../src/gates/review-reuse';
import { stringSha256 } from '../../../../src/gate-runtime/hash';
import { normalizeReviewTriggerPolicyFromPaths } from '../../../../src/policy/review-trigger-policy';
import {
    validateReviewContextMaterializationSnapshot
} from '../../../../src/gates/review-reuse/review-reuse-materialization';

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(result.status, 0, String(result.stderr || result.error || 'git command failed'));
}

function writePathsConfig(repoRoot: string, config: Record<string, unknown>): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

describe('gates/review-reuse', () => {
    it('keeps source declarations in reuse hashes and preserves frozen roles despite live path edits', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-frozen-role-reuse-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'quality'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'perf'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'docs/view.mdx'), 'before\n');
            fs.writeFileSync(path.join(repoRoot, 'perf/engine.rules'), 'before\n');
            fs.writeFileSync(path.join(repoRoot, 'quality/purchase.case'), 'test\n');
            fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Guide\n');
            const roleConfig = { file_roles: {
                'docs/view.mdx': 'source', 'perf/engine.rules': 'source', 'quality/purchase.case': 'test'
            } };
            writePathsConfig(repoRoot, roleConfig);
            const preflight = { changed_files: ['docs/view.mdx', 'perf/engine.rules', 'quality/purchase.case'],
                detection_source: 'explicit_changed_files', profile_policy_snapshot: {
                    review_trigger_policy: normalizeReviewTriggerPolicyFromPaths(roleConfig)
                } };
            const before = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
            assert.deepEqual(before.non_test_changed_files, ['docs/view.mdx', 'perf/engine.rules']);
            assert.deepEqual(before.performance_support_changed_files, []);
            assert.equal(before.docs_only, false);
            assert.equal(before.test_only, false);
            writePathsConfig(repoRoot, { file_roles: { 'docs/view.mdx': 'test' } });
            assert.deepEqual(computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot), before);
            fs.writeFileSync(path.join(repoRoot, 'docs/view.mdx'), 'after\n');
            assert.notEqual(computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot).code_scope_sha256,
                before.code_scope_sha256);
            const afterDocs = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
            fs.writeFileSync(path.join(repoRoot, 'perf/engine.rules'), 'after\n');
            assert.notEqual(computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot).code_scope_sha256,
                afterDocs.code_scope_sha256);
            assert.equal(computeReviewReuseCodeScopeFingerprint('code', {
                ...preflight, changed_files: ['README.md']
            }, repoRoot).docs_only, true);
        } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
    });

    it('reconstructs the historical schema-3 reuse hash from a current review context', () => {
        const legacyContext = {
            schema_version: 3,
            review_type: 'code',
            depth: 2,
            review_execution: {
                mode: 'FULL',
                contract_sha256: '1'.repeat(64),
                full_review_scope_sha256: '2'.repeat(64)
            }
        };
        const currentContext = {
            ...legacyContext,
            schema_version: 4
        };

        assert.equal(
            computeReviewContextReuseHash(legacyContext),
            computeSchema3ReviewContextReuseCompatibilityHash(currentContext)
        );
        assert.notEqual(
            computeReviewContextReuseHash(currentContext),
            computeReviewContextReuseHash(legacyContext)
        );
    });

    it('uses the stable instruction contract instead of cycle-specific prompt artifact hashes', () => {
        const baseContext = {
            rule_context: {
                source_file_count: 1,
                source_files: [{ path: '80-task-workflow.md', sha256: '1'.repeat(64) }],
                instruction_contract_sha256: '2'.repeat(64),
                role_prompt_sha256: '3'.repeat(64),
                prompt_template_sha256: '4'.repeat(64),
                output_template_sha256: '5'.repeat(64)
            }
        };
        const nextCycleContext = {
            rule_context: {
                ...baseContext.rule_context,
                role_prompt_sha256: '6'.repeat(64),
                prompt_template_sha256: '7'.repeat(64),
                output_template_sha256: '8'.repeat(64)
            }
        };
        const changedInstructionContract = {
            rule_context: {
                ...nextCycleContext.rule_context,
                instruction_contract_sha256: '9'.repeat(64)
            }
        };

        assert.equal(
            computeReviewRuleContextReuseHash(nextCycleContext),
            computeReviewRuleContextReuseHash(baseContext)
        );
        assert.notEqual(
            computeReviewRuleContextReuseHash(changedInstructionContract),
            computeReviewRuleContextReuseHash(baseContext)
        );
    });

    it('fingerprints staged scope from the index instead of the dirty working tree', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-staged-scope-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'reviewed.ts'), 'export const reviewed = "alpha";\n', 'utf8');
            runGit(repoRoot, ['add', 'src/reviewed.ts']);
            const preflight = {
                detection_source: 'git_staged_only',
                changed_files: ['src/reviewed.ts']
            };
            const stagedAlphaCodeScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const stagedAlphaReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

            fs.writeFileSync(path.join(repoRoot, 'src', 'reviewed.ts'), 'export const reviewed = "bravo";\n', 'utf8');
            const dirtyWorktreeCodeScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const dirtyWorktreeReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);
            assert.equal(dirtyWorktreeCodeScope.code_scope_sha256, stagedAlphaCodeScope.code_scope_sha256);
            assert.equal(dirtyWorktreeReviewScope.review_scope_sha256, stagedAlphaReviewScope.review_scope_sha256);

            runGit(repoRoot, ['add', 'src/reviewed.ts']);
            const stagedBravoCodeScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const stagedBravoReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);
            assert.notEqual(stagedBravoCodeScope.code_scope_sha256, stagedAlphaCodeScope.code_scope_sha256);
            assert.notEqual(stagedBravoReviewScope.review_scope_sha256, stagedAlphaReviewScope.review_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps benchmark and perf support paths inside code-review scope', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-perf-path-scope-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'apps', 'shop', 'perf'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const perf = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'apps', 'shop', 'perf', 'cache.ts'), 'export const cache = "alpha";\n', 'utf8');

            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['benchmark/reviewed.ts', 'apps/shop/perf/cache.ts']
            };
            const alphaScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            assert.deepEqual(alphaScope.non_test_changed_files, ['apps/shop/perf/cache.ts', 'benchmark/reviewed.ts']);

            fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const perf = "bravo";\n', 'utf8');
            const bravoScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            assert.notEqual(bravoScope.code_scope_sha256, alphaScope.code_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps performance-triggered runtime files inside code-review scope', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-runtime-perf-trigger-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src', 'auth'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'auth', 'TokenCache.ts'), 'export const cache = "alpha";\n', 'utf8');
            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['src/auth/TokenCache.ts']
            };

            const alphaScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            assert.deepEqual(alphaScope.non_test_changed_files, ['src/auth/TokenCache.ts']);

            fs.writeFileSync(path.join(repoRoot, 'src', 'auth', 'TokenCache.ts'), 'export const cache = "bravo";\n', 'utf8');
            const bravoScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            assert.notEqual(bravoScope.code_scope_sha256, alphaScope.code_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('does not fingerprint review reuse scope from files reached through symlinked directories outside repo', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-dir-symlink-'));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-outside-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.writeFileSync(path.join(outsideRoot, 'secret.ts'), 'export const secret = "alpha";\n', 'utf8');
            const linkedDirPath = path.join(repoRoot, 'src', 'linked-outside');
            try {
                fs.symlinkSync(outsideRoot, linkedDirPath, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }
            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['src/linked-outside/secret.ts']
            };

            const alphaScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            fs.writeFileSync(path.join(outsideRoot, 'secret.ts'), 'export const secret = "bravo";\n', 'utf8');
            const bravoScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);

            assert.equal(bravoScope.code_scope_sha256, alphaScope.code_scope_sha256);
            assert.deepEqual(bravoScope.missing_non_test_files, []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it('limits code-review reuse scope to non-performance code while keeping performance scope complete', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-code-perf-support-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'apps', 'shop', 'perf'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const app = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const perf = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'apps', 'shop', 'perf', 'cache.ts'), 'export const cache = "alpha";\n', 'utf8');

            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['src/app.ts', 'benchmark/reviewed.ts', 'apps/shop/perf/cache.ts']
            };
            const defaultScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const codeReuseScope = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
            const performanceReuseScope = computeReviewReuseCodeScopeFingerprint('performance', preflight, repoRoot);

            assert.deepEqual(
                defaultScope.non_test_changed_files,
                ['apps/shop/perf/cache.ts', 'benchmark/reviewed.ts', 'src/app.ts']
            );
            assert.deepEqual(codeReuseScope.performance_support_changed_files, ['benchmark/reviewed.ts']);
            assert.deepEqual(codeReuseScope.non_test_changed_files, ['apps/shop/perf/cache.ts', 'src/app.ts']);
            assert.deepEqual(
                performanceReuseScope.non_test_changed_files,
                ['apps/shop/perf/cache.ts', 'benchmark/reviewed.ts', 'src/app.ts']
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('treats configured ordinary docs as docs-only review reuse scope', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-ordinary-docs-'));
        try {
            writePathsConfig(repoRoot, {
                ordinary_doc_paths: ['docs/plan.md']
            });
            fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'docs', 'plan.md'), '# Plan\n', 'utf8');

            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['docs/plan.md']
            };

            const codeScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const reviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

            assert.deepEqual(codeScope.non_test_changed_files, []);
            assert.deepEqual(codeScope.docs_only_changed_files, ['docs/plan.md']);
            assert.equal(codeScope.docs_only, true);
            assert.deepEqual(reviewScope.review_relevant_changed_files, []);
            assert.deepEqual(reviewScope.docs_only_changed_files, ['docs/plan.md']);
            assert.equal(reviewScope.docs_only, true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps closeout evidence out of review reuse fingerprints', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-closeout-evidence-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const app = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'TASK.md'), '# Tasks\n\n| T-1 | TODO |\n', 'utf8');

            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['src/app.ts', 'TASK.md']
            };
            const alphaCodeScope = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
            const alphaReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

            fs.writeFileSync(path.join(repoRoot, 'TASK.md'), '# Tasks\n\n| T-1 | IN_REVIEW |\n', 'utf8');
            const bravoCodeScope = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
            const bravoReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

            assert.deepEqual(bravoCodeScope.non_test_changed_files, ['src/app.ts']);
            assert.deepEqual(bravoCodeScope.review_reuse_neutral_closeout_files, ['TASK.md']);
            assert.equal(bravoCodeScope.code_scope_sha256, alphaCodeScope.code_scope_sha256);
            assert.deepEqual(bravoReviewScope.review_relevant_changed_files, ['src/app.ts']);
            assert.deepEqual(bravoReviewScope.review_reuse_neutral_closeout_files, ['TASK.md']);
            assert.equal(bravoReviewScope.review_scope_sha256, alphaReviewScope.review_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps provider instruction surfaces inside review reuse fingerprints', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-agent-instructions-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const app = "alpha";\n', 'utf8');
            fs.writeFileSync(
                path.join(repoRoot, '.agents', 'workflows', 'start-task.md'),
                '# Start\n\nUse required reviews.\n',
                'utf8'
            );

            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['src/app.ts', '.agents/workflows/start-task.md']
            };
            const alphaCodeScope = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
            const alphaReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

            fs.writeFileSync(
                path.join(repoRoot, '.agents', 'workflows', 'start-task.md'),
                '# Start\n\nSkip required reviews.\n',
                'utf8'
            );
            const bravoCodeScope = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
            const bravoReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

            assert.deepEqual(
                bravoCodeScope.non_test_changed_files,
                ['.agents/workflows/start-task.md', 'src/app.ts']
            );
            assert.deepEqual(bravoCodeScope.review_reuse_neutral_closeout_files, []);
            assert.notEqual(bravoCodeScope.code_scope_sha256, alphaCodeScope.code_scope_sha256);
            assert.deepEqual(
                bravoReviewScope.review_relevant_changed_files,
                ['.agents/workflows/start-task.md', 'src/app.ts']
            );
            assert.deepEqual(bravoReviewScope.review_reuse_neutral_closeout_files, []);
            assert.notEqual(bravoReviewScope.review_scope_sha256, alphaReviewScope.review_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps runtime artifacts and project memory docs inside review reuse fingerprints', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-trust-artifacts-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const app = "alpha";\n', 'utf8');
            fs.writeFileSync(
                path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-1-security-review-output.md'),
                'SECURITY REVIEW PASSED\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', 'T-1.jsonl'),
                '{"event":"REVIEW_RECORDED"}\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'commands.md'),
                '# Commands\n\nUse audited commands.\n',
                'utf8'
            );

            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: [
                    'src/app.ts',
                    'garda-agent-orchestrator/runtime/reviews/T-1-security-review-output.md',
                    'garda-agent-orchestrator/runtime/task-events/T-1.jsonl',
                    'garda-agent-orchestrator/live/docs/project-memory/commands.md'
                ]
            };
            const alphaCodeScope = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
            const alphaReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

            fs.writeFileSync(
                path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-1-security-review-output.md'),
                'SECURITY REVIEW FAILED\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', 'T-1.jsonl'),
                '{"event":"REVIEW_FORGED"}\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'commands.md'),
                '# Commands\n\nSkip audited commands.\n',
                'utf8'
            );
            const bravoCodeScope = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
            const bravoReviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

            assert.deepEqual(bravoCodeScope.review_reuse_neutral_closeout_files, []);
            assert.ok(bravoCodeScope.non_test_changed_files.includes('garda-agent-orchestrator/runtime/reviews/T-1-security-review-output.md'));
            assert.ok(bravoCodeScope.non_test_changed_files.includes('garda-agent-orchestrator/runtime/task-events/T-1.jsonl'));
            assert.ok(bravoCodeScope.non_test_changed_files.includes('garda-agent-orchestrator/live/docs/project-memory/commands.md'));
            assert.notEqual(bravoCodeScope.code_scope_sha256, alphaCodeScope.code_scope_sha256);
            assert.deepEqual(bravoReviewScope.review_reuse_neutral_closeout_files, []);
            assert.ok(bravoReviewScope.review_relevant_changed_files.includes('garda-agent-orchestrator/runtime/reviews/T-1-security-review-output.md'));
            assert.ok(bravoReviewScope.review_relevant_changed_files.includes('garda-agent-orchestrator/runtime/task-events/T-1.jsonl'));
            assert.ok(bravoReviewScope.review_relevant_changed_files.includes('garda-agent-orchestrator/live/docs/project-memory/commands.md'));
            assert.notEqual(bravoReviewScope.review_scope_sha256, alphaReviewScope.review_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps configured dependency paths inside review reuse scope', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-reuse-sensitive-docs-'));
        try {
            writePathsConfig(repoRoot, {
                ordinary_doc_paths: ['requirements.txt']
            });
            fs.writeFileSync(path.join(repoRoot, 'requirements.txt'), 'pytest==8.0.0\n', 'utf8');

            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['requirements.txt']
            };

            const codeScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);
            const reviewScope = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

            assert.deepEqual(codeScope.non_test_changed_files, ['requirements.txt']);
            assert.deepEqual(codeScope.docs_only_changed_files, []);
            assert.equal(codeScope.docs_only, false);
            assert.deepEqual(reviewScope.review_relevant_changed_files, ['requirements.txt']);
            assert.deepEqual(reviewScope.docs_only_changed_files, []);
            assert.equal(reviewScope.docs_only, false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('ignores volatile scoped-diff paths and preflight hashes in review-context reuse hash', () => {
        const stableHash = 'a'.repeat(64);
        const baseContext = {
            schema_version: 4,
            review_type: 'security',
            depth: 2,
            token_economy_active: true,
            required_review: true,
            rule_pack: {
                selected_rule_files: ['00-core.md', '70-security.md'],
                omitted_rule_files: [],
                omission_reason: 'none'
            },
            token_economy: {
                active: true,
                flags: { scoped_diffs: true },
                omitted_sections: [],
                omission_reason: 'none'
            },
            rule_context: {
                artifact_sha256: '1'.repeat(64),
                source_file_count: 2,
                strip_examples_applied: false,
                strip_code_blocks_applied: false,
                source_files: [
                    { path: '00-core.md', sha256: 'b'.repeat(64) },
                    { path: '70-security.md', sha256: 'c'.repeat(64) }
                ]
            },
            coverage_contract: {
                contract_sha256: '2'.repeat(64)
            },
            review_execution: {
                mode: 'FULL',
                contract_sha256: '3'.repeat(64),
                full_review_scope_sha256: '4'.repeat(64)
            },
            scoped_diff: {
                expected: true,
                metadata: {
                    review_type: 'security',
                    preflight_path: 'runtime/reviews/T-1-preflight.json',
                    preflight_sha256: '1'.repeat(64),
                    paths_config_path: 'garda-agent-orchestrator/live/config/paths.json',
                    output_path: 'runtime/reviews/T-1-security-scoped.diff',
                    metadata_path: 'runtime/reviews/T-1-security-scoped.json',
                    changed_files: ['src/security/auth.ts'],
                    matched_files: ['src/security/auth.ts'],
                    changed_files_sha256: 'd'.repeat(64),
                    scope_content_sha256: 'e'.repeat(64),
                    scope_sha256: 'f'.repeat(64),
                    use_staged: false,
                    include_untracked: true,
                    fallback_to_full_diff: false,
                    output_diff_sha256: stableHash,
                    scoped_diff_line_count: 8,
                    output_diff_line_count: 8,
                    hunk_level: false
                }
            },
            reviewer_routing: {
                canonical_source_of_truth: 'Codex',
                execution_provider: 'Codex',
                execution_provider_source: 'explicit_provider',
                identity_status: 'resolved',
                delegation_required: true,
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: false,
                reviewer_execution_mode_required: true,
                reviewer_identity_required: true
            },
            plan: {
                plan_guided: false
            }
        };
        const refreshedContext = {
            ...baseContext,
            scoped_diff: {
                expected: true,
                metadata: {
                    ...(baseContext.scoped_diff.metadata),
                    detection_source: 'explicit_changed_files',
                    preflight_path: 'runtime/reviews/T-1-preflight-refresh.json',
                    preflight_sha256: '2'.repeat(64),
                    output_path: 'runtime/reviews/T-1-security-scoped-refresh.diff',
                    metadata_path: 'runtime/reviews/T-1-security-scoped-refresh.json',
                    scope_sha256: '8'.repeat(64)
                }
            },
            rule_context: {
                ...baseContext.rule_context,
                artifact_sha256: '7'.repeat(64)
            }
        };
        const changedDiffContext = {
            ...refreshedContext,
            scoped_diff: {
                expected: true,
                metadata: {
                    ...(refreshedContext.scoped_diff.metadata),
                    output_diff_sha256: '9'.repeat(64)
                }
            }
        };
        const changedRuleContext = {
            ...baseContext,
            rule_context: {
                ...baseContext.rule_context,
                source_files: [
                    { path: '00-core.md', sha256: '3'.repeat(64) },
                    { path: '70-security.md', sha256: 'c'.repeat(64) }
                ]
            }
        };
        const changedCoverageContract = {
            ...baseContext,
            coverage_contract: {
                contract_sha256: '4'.repeat(64)
            }
        };
        const changedExecutionMode = {
            ...baseContext,
            review_execution: {
                ...baseContext.review_execution,
                mode: 'DELTA'
            }
        };
        const changedExecutionScope = {
            ...baseContext,
            review_execution: {
                ...baseContext.review_execution,
                full_review_scope_sha256: '5'.repeat(64)
            }
        };
        const changedExecutionDecisionOnly = {
            ...baseContext,
            review_execution: {
                ...baseContext.review_execution,
                contract_sha256: '6'.repeat(64)
            }
        };

        assert.equal(computeReviewContextReuseHash(refreshedContext), computeReviewContextReuseHash(baseContext));
        assert.notEqual(computeReviewContextReuseHash(changedDiffContext), computeReviewContextReuseHash(baseContext));
        assert.notEqual(computeReviewContextReuseHash(changedRuleContext), computeReviewContextReuseHash(baseContext));
        assert.notEqual(computeReviewContextReuseHash(changedCoverageContract), computeReviewContextReuseHash(baseContext));
        assert.notEqual(computeReviewContextReuseHash(changedExecutionMode), computeReviewContextReuseHash(baseContext));
        assert.equal(
            computeReviewContextReuseHash(changedExecutionScope),
            computeReviewContextReuseHash(baseContext),
            'FULL reuse scope is represented by the lane coverage and content fingerprints'
        );
        assert.notEqual(
            computeReviewContextReuseHash({
                ...changedExecutionMode,
                review_execution: {
                    ...changedExecutionMode.review_execution,
                    full_review_scope_sha256: '5'.repeat(64)
                }
            }),
            computeReviewContextReuseHash(changedExecutionMode),
            'DELTA reuse keeps the authenticated full-scope lineage binding'
        );
        assert.equal(
            computeReviewContextReuseHash(changedExecutionDecisionOnly),
            computeReviewContextReuseHash(baseContext),
            'FULL remediation may carry a new decision hash while preserving the exhaustive scope contract'
        );

        assert.match(
            getReviewContextReuseContractBindingMismatch(
                resolveReviewContextReuseContractBindings(baseContext),
                resolveReviewContextReuseContractBindings(changedExecutionMode)
            ) || '',
            /review execution mode does not match/u
        );
        assert.equal(
            getReviewContextReuseContractBindingMismatch(
                resolveReviewContextReuseContractBindings(baseContext),
                resolveReviewContextReuseContractBindings(changedExecutionScope)
            ),
            null,
            'FULL reuse relies on lane coverage and content fingerprints across source-dependent scope contracts'
        );

        const currentDeltaBindings = resolveReviewContextReuseContractBindings({
            ...baseContext,
            review_execution: {
                ...baseContext.review_execution,
                mode: 'DELTA',
                contract_sha256: '6'.repeat(64)
            }
        });
        const validDeltaReceipt = {
            review_coverage_contract_sha256: currentDeltaBindings.coverageContractSha256,
            review_rule_context_sha256: currentDeltaBindings.ruleContextSha256,
            review_execution_mode: 'DELTA',
            review_execution_contract_sha256: currentDeltaBindings.reviewExecutionContractSha256,
            review_execution_full_scope_sha256: currentDeltaBindings.reviewExecutionFullScopeSha256
        };
        assert.equal(
            getReviewContextReuseContractBindingMismatch(
                resolveReviewReceiptReuseContractBindings(validDeltaReceipt),
                currentDeltaBindings
            ),
            null
        );
        assert.match(
            getReviewContextReuseContractBindingMismatch(
                resolveReviewReceiptReuseContractBindings({
                    ...validDeltaReceipt,
                    review_execution_contract_sha256: '7'.repeat(64)
                }),
                currentDeltaBindings
            ) || '',
            /reused DELTA review execution contract does not match/u
        );
        assert.match(
            getReviewContextReuseContractBindingMismatch(
                resolveReviewReceiptReuseContractBindings({
                    ...validDeltaReceipt,
                    review_execution_full_scope_sha256: '8'.repeat(64)
                }),
                currentDeltaBindings
            ) || '',
            /reused review execution full scope does not match/u
        );
        assert.match(
            getReviewContextReuseContractBindingMismatch(
                resolveReviewReceiptReuseContractBindings({
                    ...validDeltaReceipt,
                    review_execution_mode: undefined
                }),
                currentDeltaBindings
            ) || '',
            /reused review execution mode is missing for a current DELTA/u
        );
    });

    it('rejects replaced review-context drift between reuse validation and evidence materialization', () => {
        const initialContext = {
            schema_version: 3,
            review_type: 'code',
            tree_state: {
                tree_state_sha256: 'a'.repeat(64)
            },
            rule_context: {
                source_files: [
                    { path: '00-core.md', sha256: 'b'.repeat(64) }
                ]
            },
            coverage_contract: {
                contract_sha256: 'c'.repeat(64)
            },
            review_execution: {
                mode: 'FULL',
                contract_sha256: 'e'.repeat(64),
                full_review_scope_sha256: 'f'.repeat(64)
            }
        };
        const initialContextText = `${JSON.stringify(initialContext, null, 2)}\n`;
        const expectations = {
            currentReviewContextSha256: stringSha256(initialContextText),
            currentReviewTreeStateSha256: initialContext.tree_state.tree_state_sha256,
            currentContextReuseSha256: computeReviewContextReuseHash(initialContext),
            currentReviewContextContractBindings: resolveReviewContextReuseContractBindings(initialContext)
        };

        assert.equal(
            validateReviewContextMaterializationSnapshot(
                expectations,
                initialContextText,
                initialContext
            ),
            null
        );

        const driftedContext = {
            ...initialContext,
            tree_state: {
                tree_state_sha256: 'd'.repeat(64)
            }
        };
        const driftedContextText = `${JSON.stringify(driftedContext, null, 2)}\n`;

        assert.match(
            validateReviewContextMaterializationSnapshot(
                expectations,
                driftedContextText,
                driftedContext
            ) || '',
            /current review context changed before reused evidence materialization/u
        );

        const forgedExecutionContext = {
            ...initialContext,
            review_execution: {
                ...initialContext.review_execution,
                contract_sha256: '1'.repeat(64)
            }
        };
        const forgedExecutionContextText = `${JSON.stringify(forgedExecutionContext, null, 2)}\n`;
        assert.match(
            validateReviewContextMaterializationSnapshot(
                {
                    ...expectations,
                    currentReviewContextSha256: stringSha256(forgedExecutionContextText)
                },
                forgedExecutionContextText,
                forgedExecutionContext
            ) || '',
            /current review context contract bindings changed/u
        );
    });
});
