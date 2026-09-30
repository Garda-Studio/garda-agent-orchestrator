import { describe, it } from 'node:test';
import {
    assert,
    fs,
    os,
    path,
    buildReviewContext,
    getRulePack,
    getWorkspaceSnapshot,
    buildChangedFileFingerprintEntries,
    runGit,
    writeTaskModeArtifactFixture
} from './build-review-context-fixtures';

describe('gates/build-review-context scope safety and diff bounds', () => {
        it('does not require scoped diff metadata for true docs-only review contexts', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-docs-only-scoped-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
            for (const ruleFile of getRulePack('security').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'docs', 'usage.md'), '# Usage\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({
                enabled: true,
                enabled_depths: [1, 2],
                scoped_diffs: true
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-docs-only-scoped', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-docs-only-scoped-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-docs-only-scoped',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'docs-only',
                changed_files: ['docs/usage.md'],
                required_reviews: { security: true },
                triggers: { runtime_changed: false, runtime_code_changed: false, security: true },
                budget_forecast: { token_economy_active_for_depth: true },
                risk_aware_depth: { compression: { scoped_diffs: true } }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'security',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-docs-only-scoped-security-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-docs-only-scoped-security-review-context.json'),
                repoRoot
            });

            assert.equal(result.scoped_diff.expected, false);
            assert.equal(result.scoped_diff.metadata, null);
            assert.equal(result.task_scope.diff.available, true);
            assert.deepEqual(result.review_execution.full_review_scope, ['docs/usage.md']);
            assert.equal(result.coverage_contract.required, true);
            assert.deepEqual(
                result.coverage_contract.obligations.filter((entry) => entry.kind === 'file').map((entry) => entry.target),
                ['docs/usage.md']
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('preserves whitespace in untracked file content for reviewer prompt artifacts', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-explicit-untracked-whitespace-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'new.ts'),
                '  export const created = true;\nexport const spaced = true;   ',
                'utf8'
            );
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-explicit-untracked-whitespace', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-explicit-untracked-whitespace-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-explicit-untracked-whitespace',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/new.ts'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-explicit-untracked-whitespace-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-explicit-untracked-whitespace-code-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            assert.ok(promptArtifact.includes('+  export const created = true;'));
            assert.ok(promptArtifact.includes('+export const spaced = true;   '));
            assert.equal(result.task_scope.diff.source, 'git_diff_head_plus_untracked');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('invalidates shared scoped diff cache when same preflight file content changes with identical stat output', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-diff-cache-content-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('security').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'cached.ts'), 'export const cached = "alpha";\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-diff-cache-content', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-diff-cache-content-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-diff-cache-content',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/cached.ts'],
                required_reviews: { code: true, security: false, refactor: false },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const firstResult = buildReviewContext({
                reviewType: 'security',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-diff-cache-content-security-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-diff-cache-content-security-review-context.json'),
                repoRoot
            });
            const firstPromptArtifact = fs.readFileSync(firstResult.rule_context.artifact_path, 'utf8');
            assert.ok(firstPromptArtifact.includes('+export const cached = "alpha";'));

            fs.writeFileSync(path.join(repoRoot, 'src', 'cached.ts'), 'export const cached = "bravo";\n', 'utf8');
            const secondResult = buildReviewContext({
                reviewType: 'refactor',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-diff-cache-content-refactor-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-diff-cache-content-refactor-review-context.json'),
                repoRoot
            });

            const secondPromptArtifact = fs.readFileSync(secondResult.rule_context.artifact_path, 'utf8');
            assert.ok(secondPromptArtifact.includes('+export const cached = "bravo";'));
            assert.equal(secondPromptArtifact.includes('+export const cached = "alpha";'), false);
            assert.equal(Object.hasOwn(secondResult.task_scope.diff, 'cached'), false);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('invalidates shared diff cache when staged baseline trust triggers change without file diff changes', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-staged-trust-cache-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'trusted.ts'), 'export const trusted = "baseline";\n', 'utf8');
            runGit(repoRoot, ['add', 'src/trusted.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'trusted.ts'), 'export const trusted = "current";\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-staged-trust-cache', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-staged-trust-cache-preflight.json');
            const preflight = {
                task_id: 'T-901-staged-trust-cache',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/trusted.ts'],
                required_reviews: { code: true, refactor: true },
                triggers: {
                    runtime_changed: true,
                    runtime_code_changed: true,
                    dirty_workspace_staged_baseline_trust_status: 'PASS',
                    dirty_workspace_staged_baseline_trust_violations: [],
                    dirty_workspace_staged_baseline_trust_input_sha256: 'a'.repeat(64)
                }
            };
            fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2), 'utf8');

            const codeScopedDiffPath = path.join(reviewsRoot, 'T-901-staged-trust-cache-code-scoped.json');
            const codeReviewContextPath = path.join(reviewsRoot, 'T-901-staged-trust-cache-code-review-context.json');
            const buildCodeReviewContext = () => buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: codeScopedDiffPath,
                outputPath: codeReviewContextPath,
                repoRoot
            });
            const firstResult = buildCodeReviewContext();
            const firstContextText = fs.readFileSync(codeReviewContextPath, 'utf8');
            const diffCachePath = String(firstResult.task_scope.diff.cache_path);
            const firstCacheText = fs.readFileSync(diffCachePath, 'utf8');
            const firstCache = JSON.parse(firstCacheText) as Record<string, unknown>;
            assert.equal(firstCache.schema_version, 2);
            assert.equal(Object.hasOwn(firstCache, 'generated_at_utc'), false);
            assert.equal(Object.hasOwn(firstResult.task_scope.diff, 'cached'), false);

            const cachedResult = buildCodeReviewContext();
            assert.equal(fs.readFileSync(codeReviewContextPath, 'utf8'), firstContextText);
            assert.equal(fs.readFileSync(diffCachePath, 'utf8'), firstCacheText);
            assert.equal(Object.hasOwn(cachedResult.task_scope.diff, 'cached'), false);

            fs.rmSync(diffCachePath, { force: true });
            const regeneratedResult = buildCodeReviewContext();
            assert.equal(fs.readFileSync(codeReviewContextPath, 'utf8'), firstContextText);
            assert.equal(fs.readFileSync(diffCachePath, 'utf8'), firstCacheText);
            assert.equal(Object.hasOwn(regeneratedResult.task_scope.diff, 'cached'), false);

            fs.writeFileSync(preflightPath, JSON.stringify({
                ...preflight,
                triggers: {
                    ...preflight.triggers,
                    dirty_workspace_staged_baseline_trust_status: 'FAIL',
                    dirty_workspace_staged_baseline_trust_violations: ['Staged trust content fingerprint mismatch for \'src/trusted.ts\'.'],
                    dirty_workspace_staged_baseline_trust_input_sha256: 'b'.repeat(64)
                }
            }, null, 2), 'utf8');
            const refreshedResult = buildReviewContext({
                reviewType: 'refactor',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-staged-trust-cache-refactor-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-staged-trust-cache-refactor-review-context.json'),
                repoRoot
            });

            assert.equal(Object.hasOwn(refreshedResult.task_scope.diff, 'cached'), false);
            assert.equal(
                JSON.parse(fs.readFileSync(preflightPath, 'utf8')).triggers.dirty_workspace_staged_baseline_trust_status,
                'FAIL'
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('does not expand glob-looking changed files as git pathspecs', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-literal-pathspec-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'secret.ts'), 'export const secret = "do-not-include";\n', 'utf8');
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-literal-pathspec', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-literal-pathspec-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-literal-pathspec',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/*.ts'],
                required_reviews: { code: false },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-literal-pathspec-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-literal-pathspec-code-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            assert.equal(promptArtifact.includes('do-not-include'), false);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects git pathspec magic in preflight changed files', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-pathspec-magic-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-pathspec-magic', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-pathspec-magic-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-pathspec-magic',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: [':(glob)src/*.ts'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            assert.throws(() => buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-pathspec-magic-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-pathspec-magic-code-review-context.json'),
                repoRoot
            }), /unsafe path/);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects preflight artifacts that escape the repo through symlinked review directories', (t) => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-preflight-link-'));
            const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-preflight-outside-'));
            try {
                const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
                const runtimeRoot = path.join(orchestratorRoot, 'runtime');
                const reviewsRoot = path.join(runtimeRoot, 'reviews');
                fs.mkdirSync(runtimeRoot, { recursive: true });
                try {
                    fs.symlinkSync(outsideRoot, reviewsRoot, process.platform === 'win32' ? 'junction' : 'dir');
                } catch (error) {
                    t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                    return;
                }
                const preflightPath = path.join(reviewsRoot, 'T-901-preflight-link-preflight.json');
                fs.writeFileSync(preflightPath, JSON.stringify({
                    task_id: 'T-901-preflight-link',
                    detection_source: 'explicit_changed_files',
                    changed_files: ['src/app.ts'],
                    required_reviews: { code: true }
                }), 'utf8');

                assert.throws(() => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-preflight-link-code-scoped.json'),
                    outputPath: path.join(reviewsRoot, 'T-901-preflight-link-code-review-context.json'),
                    repoRoot
                }), /PreflightPath must resolve inside repo root/);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
                fs.rmSync(outsideRoot, { recursive: true, force: true });
            }
        });

        it('rejects untracked symlinks that resolve outside the repo before building reviewer prompt artifacts', (t) => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-untracked-symlink-'));
            const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-outside-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            const outsideSecretPath = path.join(outsideRoot, 'secret.txt');
            const secret = 'outside-secret-that-must-not-enter-review-context';
            fs.writeFileSync(outsideSecretPath, `${secret}\n`, 'utf8');
            const symlinkPath = path.join(repoRoot, 'src', 'linked-secret.txt');
            try {
                fs.symlinkSync(outsideSecretPath, symlinkPath, 'file');
            } catch (error) {
                fs.rmSync(repoRoot, { recursive: true, force: true });
                fs.rmSync(outsideRoot, { recursive: true, force: true });
                t.skip(`symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-untracked-symlink', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-untracked-symlink-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-untracked-symlink',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/linked-secret.txt'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            assert.throws(() => buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-untracked-symlink-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-untracked-symlink-code-review-context.json'),
                repoRoot
            }), /Review scope contains paths that resolve outside the repo/);
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        });

        it('rejects untracked files under symlinked directories before building reviewer prompt artifacts', (t) => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-untracked-dir-symlink-'));
            const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-outside-dir-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            runGit(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            const outsideSecretPath = path.join(outsideRoot, 'secret.txt');
            const secret = 'outside-directory-secret-that-must-not-enter-review-context';
            fs.writeFileSync(outsideSecretPath, `${secret}\n`, 'utf8');
            const symlinkDirPath = path.join(repoRoot, 'src', 'linked-outside');
            try {
                fs.symlinkSync(outsideRoot, symlinkDirPath, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error) {
                fs.rmSync(repoRoot, { recursive: true, force: true });
                fs.rmSync(outsideRoot, { recursive: true, force: true });
                t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-untracked-dir-symlink', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-untracked-dir-symlink-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-untracked-dir-symlink',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/linked-outside/secret.txt'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const snapshotBeforeExternalChange = getWorkspaceSnapshot(
                repoRoot,
                'explicit_changed_files',
                true,
                ['src/linked-outside/secret.txt']
            );
            fs.writeFileSync(outsideSecretPath, `${secret}-changed\nsecond-outside-line\n`, 'utf8');
            const snapshotAfterExternalChange = getWorkspaceSnapshot(
                repoRoot,
                'explicit_changed_files',
                true,
                ['src/linked-outside/secret.txt']
            );
            assert.equal(snapshotAfterExternalChange.scope_content_sha256, snapshotBeforeExternalChange.scope_content_sha256);
            assert.equal(snapshotAfterExternalChange.changed_lines_total, snapshotBeforeExternalChange.changed_lines_total);

            const fingerprintEntries = buildChangedFileFingerprintEntries(repoRoot, ['src/linked-outside/secret.txt']);
            assert.equal(fingerprintEntries[0].status, 'outside_repo');
            assert.equal(Object.prototype.hasOwnProperty.call(fingerprintEntries[0], 'sha256'), false);

            assert.throws(() => buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-untracked-dir-symlink-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-untracked-dir-symlink-code-review-context.json'),
                repoRoot
            }), /Review scope contains paths that resolve outside the repo/);

            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        });

        it('bounds oversized staged diffs instead of failing on process output buffers', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-large-diff-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            runGit(repoRoot, ['init']);
            for (const ruleFile of getRulePack('code').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'large.txt'), `${'x'.repeat(70000)}\n`, 'utf8');
            runGit(repoRoot, ['add', 'src/large.txt']);
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-large-diff', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-large-diff-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-large-diff',
                detection_source: 'git_staged_only',
                mode: 'FULL_PATH',
                scope_category: 'code',
                changed_files: ['src/large.txt'],
                required_reviews: { code: true },
                triggers: { runtime_changed: true, runtime_code_changed: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-large-diff-code-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-large-diff-code-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            assert.ok(promptArtifact.includes('[diff excerpt truncated at 60000 chars'));
            assert.equal(result.task_scope.diff.truncated, true);
            assert.equal(typeof result.task_scope.diff.cache_path, 'string');
            assert.equal(fs.existsSync(String(result.task_scope.diff.cache_path)), true);

            const securityResult = buildReviewContext({
                reviewType: 'security',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-large-diff-security-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-large-diff-security-review-context.json'),
                repoRoot
            });

            const securityPromptArtifact = fs.readFileSync(securityResult.rule_context.artifact_path, 'utf8');
            assert.ok(securityPromptArtifact.includes('[diff excerpt truncated at 20000 chars'));
            assert.ok(securityPromptArtifact.includes('full bounded scoped diff cache'));
            assert.equal(Object.hasOwn(securityResult.task_scope.diff, 'cached'), false);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });
});
