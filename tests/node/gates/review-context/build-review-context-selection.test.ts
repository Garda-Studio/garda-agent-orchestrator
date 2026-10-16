import { describe, it } from 'node:test';
import {
    assert,
    fs,
    os,
    path,
    appendTaskEvent,
    buildReviewContext,
    writeCurrentPreflightFixture,
    getRulePack,
    buildTaskModeArtifact,
    resolveTaskModeArtifactPath,
    resolveRuntimeReviewerIdentity,
    runGit,
    writeTaskModeArtifactFixture
} from './build-review-context-fixtures';

describe('gates/build-review-context excerpt selection and runtime identity', () => {
        it('prioritizes gate implementation diff sections in API review prompt excerpts', async () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-api-priority-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'template', 'docs', 'agent-rules'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src', 'cli', 'commands'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src', 'gates', 'rule-pack'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'tests', 'node', 'cli', 'commands'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            for (const ruleFile of getRulePack('api').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'template', 'docs', 'agent-rules', '80-task-workflow.md'), '# Workflow\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'src', 'cli', 'commands', 'gate-command.ts'), 'export const beforeGate = true;\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'src', 'gates', 'rule-pack', 'rule-pack.ts'), 'export const before = true;\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.ts'), 'import assert from "node:assert/strict";\n', 'utf8');
            runGit(repoRoot, ['add', '.']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI\nbind-rule-pack-to-preflight --task-mode-path\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'template', 'docs', 'agent-rules', '80-task-workflow.md'), `# Workflow\n${'template filler\n'.repeat(9000)}`, 'utf8');
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'cli', 'commands', 'gate-command.ts'),
                'export function handleBindRulePackToPreflight() { return "api-cli-visible"; }\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'gates', 'rule-pack', 'rule-pack.ts'),
                'export function getPostPreflightRulePackRebindDecision() { return "api-priority-visible"; }\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(repoRoot, 'tests', 'node', 'cli', 'commands', 'gates.test.ts'),
                'import assert from "node:assert/strict";\nassert.equal("api-test-visible", "api-test-visible");\n',
                'utf8'
            );
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-api-priority', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-api-priority-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-api-priority',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'mixed',
                changed_files: [
                    'docs/cli-reference.md',
                    'template/docs/agent-rules/80-task-workflow.md',
                    'src/cli/commands/gate-command.ts',
                    'src/gates/rule-pack/rule-pack.ts',
                    'tests/node/cli/commands/gates.test.ts'
                ],
                required_reviews: { api: true },
                triggers: { runtime_changed: true, runtime_code_changed: true, api: true }
            }, null, 2), 'utf8');
            await writeCurrentPreflightFixture(repoRoot, preflightPath);

            const result = buildReviewContext({
                reviewType: 'api',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-api-priority-api-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-api-priority-api-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            const gateDiffIndex = promptArtifact.indexOf('diff --git a/src/gates/rule-pack/rule-pack.ts');
            const cliDiffIndex = promptArtifact.indexOf('diff --git a/src/cli/commands/gate-command.ts');
            const docsDiffIndex = promptArtifact.indexOf('diff --git a/docs/cli-reference.md');
            const testDiffIndex = promptArtifact.indexOf('diff --git a/tests/node/cli/commands/gates.test.ts');
            const templateDiffIndex = promptArtifact.indexOf('diff --git a/template/docs/agent-rules/80-task-workflow.md');
            assert.ok(gateDiffIndex >= 0, 'API review prompt excerpt should include gate implementation diff');
            assert.ok(cliDiffIndex >= 0, 'API review prompt excerpt should include CLI command diff');
            assert.ok(docsDiffIndex >= 0, 'API review prompt excerpt should include CLI documentation diff');
            assert.ok(testDiffIndex >= 0, 'API review prompt excerpt should include CLI API test diff');
            assert.ok(promptArtifact.includes('api-priority-visible'));
            assert.ok(promptArtifact.includes('api-cli-visible'));
            assert.ok(promptArtifact.includes('api-test-visible'));
            assert.ok(gateDiffIndex < cliDiffIndex, 'API review prompt excerpt should prioritize rebind decision before CLI surface');
            assert.ok(cliDiffIndex < docsDiffIndex, 'API review prompt excerpt should prioritize CLI surface before docs');
            assert.ok(docsDiffIndex < testDiffIndex, 'API review prompt excerpt should prioritize CLI docs before API tests');
            assert.ok(templateDiffIndex < 0 || testDiffIndex < templateDiffIndex, 'API review prompt excerpt should defer bulky template docs');
            assert.equal(result.task_scope.diff.prompt_max_chars, 60000);
            assert.ok(promptArtifact.includes('[diff excerpt truncated at 60000 chars'));
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('prioritizes changed test diff sections in test review prompt excerpts', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-test-priority-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
            const rulesRoot = path.join(orchestratorRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.mkdirSync(rulesRoot, { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'tests', 'node', 'gates'), { recursive: true });
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            for (const ruleFile of getRulePack('test').full) {
                fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
            }
            fs.writeFileSync(path.join(repoRoot, 'src', 'large.ts'), 'export const before = true;\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'gates', 'next-step.test.ts'), 'import assert from "node:assert/strict";\n', 'utf8');
            runGit(repoRoot, ['add', '.']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'large.ts'),
                `${'export const filler = "'.repeat(2500)}tail";\n`,
                'utf8'
            );
            fs.appendFileSync(
                path.join(repoRoot, 'tests', 'node', 'gates', 'next-step.test.ts'),
                'assert.equal("review-cycle-block-test-priority", "review-cycle-block-test-priority");\n',
                'utf8'
            );
            const tokenConfigPath = path.join(orchestratorRoot, 'live', 'config', 'token-economy.json');
            fs.writeFileSync(tokenConfigPath, JSON.stringify({ enabled: true, enabled_depths: [1, 2] }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-test-priority', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            const preflightPath = path.join(reviewsRoot, 'T-901-test-priority-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-test-priority',
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                scope_category: 'mixed',
                changed_files: [
                    'src/large.ts',
                    'tests/node/gates/next-step.test.ts'
                ],
                required_reviews: { code: true, test: true },
                triggers: { runtime_changed: true, runtime_code_changed: true, test: true }
            }, null, 2), 'utf8');

            const result = buildReviewContext({
                reviewType: 'test',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: tokenConfigPath,
                scopedDiffMetadataPath: path.join(reviewsRoot, 'T-901-test-priority-test-scoped.json'),
                outputPath: path.join(reviewsRoot, 'T-901-test-priority-test-review-context.json'),
                repoRoot
            });

            const promptArtifact = fs.readFileSync(result.rule_context.artifact_path, 'utf8');
            const testDiffIndex = promptArtifact.indexOf('diff --git a/tests/node/gates/next-step.test.ts');
            const sourceDiffIndex = promptArtifact.indexOf('diff --git a/src/large.ts');
            assert.ok(testDiffIndex >= 0, 'test diff should be visible in the test review prompt excerpt');
            assert.ok(sourceDiffIndex >= 0, 'source diff should still be present after the prioritized test diff');
            assert.ok(testDiffIndex < sourceDiffIndex, 'test diff should appear before source diff for test reviews');
            assert.ok(promptArtifact.includes('review-cycle-block-test-priority'));
            assert.ok(promptArtifact.includes('[diff excerpt truncated at 20000 chars'));
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('preserves blocked reviewer launchability from current task-mode runtime evidence', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-task-mode-blocked-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-task-mode-blocked', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved',
                reviewerSubagentLaunchStatus: 'blocked',
                reviewerSubagentLaunchReason: 'Reviewer subagent launch is blocked for the persisted task-mode runtime.',
                reviewerSubagentLaunchRemediation: 'Re-enter task mode with a runtime session that can launch delegated reviewer subagents.'
            });

            const result = resolveRuntimeReviewerIdentity({
                repoRoot,
                taskId: 'T-901-task-mode-blocked',
                allowLegacyFallback: false
            });

            assert.equal(result.execution_provider, 'Codex');
            assert.equal(result.execution_provider_source, 'explicit_provider');
            assert.equal(result.identity_status, 'resolved');
            assert.equal(result.reviewer_subagent_launch_status, 'blocked');
            assert.match(result.reviewer_subagent_launch_reason, /persisted task-mode runtime/i);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('builds reusable non-required code review-contexts when task-mode uses a direct explicit_provider session', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-launch-blocked-reuse-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-launch-reuse-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-launch-reuse',
                required_reviews: { code: false, test: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-launch-reuse', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: null,
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-launch-reuse-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });
            assert.equal(result.reviewer_routing.execution_provider_source, 'explicit_provider');
            assert.equal(result.reviewer_routing.reviewer_subagent_launch_status, 'launchable');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects build-review-context when current task-mode runtime persists blocked reviewer launchability', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-blocked-launchability-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-launch-blocked-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-launch-blocked',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-launch-blocked', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved',
                reviewerSubagentLaunchStatus: 'blocked',
                reviewerSubagentLaunchReason: 'Reviewer subagent launch is blocked for the persisted task-mode runtime.',
                reviewerSubagentLaunchRemediation: 'Re-enter task mode with a runtime session that can launch delegated reviewer subagents.'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-launch-blocked-code-review-context.json');

            let blockedLaunchError: Error | null = null;
            try {
                buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: '',
                    outputPath,
                    repoRoot
                });
            } catch (error) {
                blockedLaunchError = error as Error;
            }
            assert.ok(blockedLaunchError);
            assert.match(blockedLaunchError.message, /delegated reviewer launch is not attested/i);
            assert.match(blockedLaunchError.message, /provider-native\/internal agent or subagent tool/i);
            assert.match(blockedLaunchError.message, /not a shell command or hand-written artifact/i);
            assert.match(blockedLaunchError.message, /Launch a real subagent using built-in tools/i);
            assert.match(blockedLaunchError.message, /if for some reason that is impossible right now, you must stop and report this to the user/i);
            assert.match(blockedLaunchError.message, /this is expected behavior in this repository/i);
            assert.match(blockedLaunchError.message, /stop and report that blocker/i);
            assert.match(blockedLaunchError.message, /instead of fabricating routing, launch, review, receipt, or telemetry evidence/i);

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('builds required review-contexts when a bridge-based provider uses its root entrypoint', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-bridge-root-entrypoint-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'GitHubCopilot'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-bridge-root-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-bridge-root',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-bridge-root', {
                provider: 'GitHubCopilot',
                canonicalSourceOfTruth: 'GitHubCopilot',
                routedTo: '.github/copilot-instructions.md',
                executionProviderSource: 'provider_entrypoint',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-bridge-root-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });
            assert.equal(result.reviewer_routing.execution_provider_source, 'provider_entrypoint');
            assert.equal(result.reviewer_routing.reviewer_subagent_launch_status, 'launchable');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('keeps review-context builds usable when routed telemetry points at a missing file', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-missing-route-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-missing-route-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-missing-route',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901-missing-route', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: 'AGENTS.md',
                materializeRoutedTo: false,
                executionProviderSource: 'provider_entrypoint',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-missing-route-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });
            assert.equal(result.reviewer_routing.execution_provider_source, 'provider_entrypoint');
            assert.equal(result.reviewer_routing.reviewer_subagent_launch_status, 'launchable');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('reads plan metadata from the explicit custom task-mode artifact path', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-plan-path-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-plan-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901-plan',
                required_reviews: { code: true }
            }, null, 2), 'utf8');

            const defaultTaskModePath = resolveTaskModeArtifactPath(repoRoot, 'T-901-plan', '');
            fs.writeFileSync(defaultTaskModePath, JSON.stringify(buildTaskModeArtifact({
                taskId: 'T-901-plan',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Drifted default task-mode artifact without plan metadata',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                runtimeIdentityStatus: 'resolved'
            }), null, 2), 'utf8');

            const customTaskModePath = path.join(orchestratorRoot, 'runtime', 'custom-artifacts', 'T-901-plan-task-mode.json');
            fs.mkdirSync(path.dirname(customTaskModePath), { recursive: true });
            const antigravityBridgePath = path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md');
            fs.mkdirSync(path.dirname(antigravityBridgePath), { recursive: true });
            fs.writeFileSync(antigravityBridgePath, '# antigravity bridge fixture\n', 'utf8');
            fs.writeFileSync(customTaskModePath, JSON.stringify(buildTaskModeArtifact({
                taskId: 'T-901-plan',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Preserve plan metadata from a custom task-mode artifact path',
                provider: 'Antigravity',
                canonicalSourceOfTruth: 'Codex',
                routedTo: '.antigravity/agents/orchestrator.md',
                executionProviderSource: 'provider_bridge',
                runtimeIdentityStatus: 'resolved',
                plan: {
                    plan_path: 'garda-agent-orchestrator/runtime/reviews/T-901-plan-task-plan.json',
                    plan_sha256: 'a'.repeat(64),
                    plan_summary: 'Preserve the approved plan from a custom task-mode artifact path'
                }
            }), null, 2), 'utf8');
            const customTaskMode = JSON.parse(fs.readFileSync(customTaskModePath, 'utf8'));
            appendTaskEvent(orchestratorRoot, 'T-901-plan', 'TASK_MODE_ENTERED', 'PASS', 'Custom-path plan fixture entry.', {
                artifact_path: customTaskModePath.replace(/\\/gu, '/'),
                canonical_source_of_truth: customTaskMode.canonical_source_of_truth,
                execution_provider_source: customTaskMode.execution_provider_source,
                runtime_identity_status: customTaskMode.runtime_identity_status,
                plan_guided: true,
                plan_path: customTaskMode.plan.plan_path,
                plan_sha256: customTaskMode.plan.plan_sha256
            });

            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-plan-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                taskModePath: customTaskModePath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });

            assert.equal(result.reviewer_routing.execution_provider, 'Antigravity');
            assert.equal(result.plan.plan_guided, true);
            assert.equal(result.plan.plan_path, 'garda-agent-orchestrator/runtime/reviews/T-901-plan-task-plan.json');
            assert.equal(result.plan.plan_summary, 'Preserve the approved plan from a custom task-mode artifact path');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects task-mode artifacts that omit pinned identity metadata', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-taskmode-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Qwen'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901',
                required_reviews: { test: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901', {
                provider: null,
                canonicalSourceOfTruth: null,
                routedTo: null,
                executionProviderSource: null,
                runtimeIdentityStatus: null
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: true,
                enabled_depths: [1, 2]
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-test-review-context.json');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'test',
                    depth: 3,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901-test-scoped.json'),
                    outputPath,
                    repoRoot
                }),
                /missing canonical_source_of_truth|missing execution_provider_source|missing runtime_identity_status/i
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects stripped current-style task-mode artifacts when latest TASK_MODE_ENTERED still carries current-era markers', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-current-era-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901c-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901c',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            const taskModePath = resolveTaskModeArtifactPath(repoRoot, 'T-901c', '');
            const raw = JSON.parse(JSON.stringify(buildTaskModeArtifact({
                taskId: 'T-901c',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Reject stripped current-style task-mode artifacts at review-context build',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                reviewerCapabilityLevel: 'delegation_required',
                reviewerExpectedExecutionMode: 'delegated_subagent',
                reviewerFallbackAllowed: false,
                reviewerFallbackReasonRequired: false,
                runtimeIdentityStatus: 'resolved'
            })));
            delete raw.canonical_source_of_truth;
            delete raw.execution_provider_source;
            delete raw.reviewer_capability_level;
            delete raw.reviewer_expected_execution_mode;
            delete raw.reviewer_fallback_allowed;
            delete raw.reviewer_fallback_reason_required;
            delete raw.runtime_identity_status;
            delete raw.runtime_identity_violations;
            fs.writeFileSync(taskModePath, JSON.stringify(raw, null, 2), 'utf8');
            appendTaskEvent(orchestratorRoot, 'T-901c', 'TASK_MODE_ENTERED', 'PASS', 'Current task-mode entry before tampering.', {
                artifact_path: taskModePath.replace(/\\/g, '/'),
                entry_mode: 'EXPLICIT_TASK_EXECUTION',
                requested_depth: 2,
                effective_depth: 2,
                task_summary: 'Reject stripped current-style task-mode artifacts at review-context build',
                canonical_source_of_truth: 'Codex',
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901c-code-review-context.json');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: '',
                    outputPath,
                    repoRoot
                }),
                /missing canonical_source_of_truth|execution_provider_source/i
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('ignores malformed tail lines after the latest valid current-era TASK_MODE_ENTERED', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-current-era-tail-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'task-events'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901d-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901d',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            const taskModePath = resolveTaskModeArtifactPath(repoRoot, 'T-901d', '');
            const raw = JSON.parse(JSON.stringify(buildTaskModeArtifact({
                taskId: 'T-901d',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Ignore malformed tail after current task-mode entry at review-context build',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                reviewerCapabilityLevel: 'delegation_required',
                reviewerExpectedExecutionMode: 'delegated_subagent',
                reviewerFallbackAllowed: false,
                reviewerFallbackReasonRequired: false,
                runtimeIdentityStatus: 'resolved'
            })));
            delete raw.canonical_source_of_truth;
            delete raw.execution_provider_source;
            delete raw.reviewer_capability_level;
            delete raw.reviewer_expected_execution_mode;
            delete raw.reviewer_fallback_allowed;
            delete raw.reviewer_fallback_reason_required;
            delete raw.runtime_identity_status;
            delete raw.runtime_identity_violations;
            fs.writeFileSync(taskModePath, JSON.stringify(raw, null, 2), 'utf8');
            appendTaskEvent(orchestratorRoot, 'T-901d', 'TASK_MODE_ENTERED', 'PASS', 'Current task-mode entry before malformed tail.', {
                artifact_path: taskModePath.replace(/\\/g, '/'),
                entry_mode: 'EXPLICIT_TASK_EXECUTION',
                requested_depth: 2,
                effective_depth: 2,
                task_summary: 'Ignore malformed tail after current task-mode entry at review-context build',
                canonical_source_of_truth: 'Codex',
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved'
            });
            fs.appendFileSync(path.join(orchestratorRoot, 'runtime', 'task-events', 'T-901d.jsonl'), '{"event_type":"TASK_MODE_ENTERED"', 'utf8');
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901d-code-review-context.json');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: '',
                    outputPath,
                    repoRoot
                }),
                /missing canonical_source_of_truth|execution_provider_source/i
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects stale provider-only task-mode artifacts even when provider matches workspace canonical owner', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-provider-only-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901b-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-901b',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-901b', {
                provider: 'Codex',
                canonicalSourceOfTruth: null,
                routedTo: null,
                executionProviderSource: null,
                runtimeIdentityStatus: null
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-901b-code-review-context.json');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: '',
                    outputPath,
                    repoRoot
                }),
                /legacy_fallback|runtime identity is invalid/i
            );
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('rejects workspace canonical drift after task-mode identity is pinned', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-drift-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-902-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-902',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-902', {
                provider: 'Antigravity',
                canonicalSourceOfTruth: 'Codex',
                routedTo: '.antigravity/agents/orchestrator.md',
                executionProviderSource: 'provider_bridge',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Qwen'
            }, null, 2), 'utf8');
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-902-code-review-context.json');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: '',
                    outputPath,
                    repoRoot
                }),
                /contradicts task-mode canonical_source_of_truth/i
            );

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        // reviewer_routing includes explicit requirement fields.
        it('includes reviewer_execution_mode_required and reviewer_identity_required for required reviews', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-req-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1005-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-1005',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-1005', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: 'AGENTS.md',
                executionProviderSource: 'provider_entrypoint',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1005-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });

            assert.equal(result.task_id, 'T-1005');
            assert.equal(result.preflight_path, preflightPath.replace(/\\/g, '/'));
            assert.equal(typeof result.preflight_sha256, 'string');
            assert.ok(String(result.preflight_sha256 || '').length > 0);
            assert.equal(result.reviewer_routing.reviewer_execution_mode_required, true);
            assert.equal(result.reviewer_routing.reviewer_identity_required, true);
            assert.equal(result.reviewer_routing.reviewer_subagent_launch_status, 'launchable');
            assert.equal(result.reviewer_routing.reviewer_subagent_launch_route, 'AGENTS.md');
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('sets reviewer requirement fields to false for non-required reviews', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-nonreq-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1005b-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-1005b',
                required_reviews: { code: false }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-1005b', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: 'AGENTS.md',
                executionProviderSource: 'provider_entrypoint',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1005b-code-review-context.json');

            const result = buildReviewContext({
                reviewType: 'code',
                depth: 2,
                preflightPath,
                tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                scopedDiffMetadataPath: '',
                outputPath,
                repoRoot
            });

            assert.equal(result.reviewer_routing.reviewer_execution_mode_required, false);
            assert.equal(result.reviewer_routing.reviewer_identity_required, false);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        it('fails fast when the review-context artifact is locked by a live writer', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-build-review-context-locked-'));
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            fs.mkdirSync(path.join(orchestratorRoot, 'runtime', 'reviews'), { recursive: true });
            fs.mkdirSync(path.join(orchestratorRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(orchestratorRoot, 'runtime', 'init-answers.json'), JSON.stringify({
                SourceOfTruth: 'Codex'
            }, null, 2), 'utf8');
            const preflightPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1006-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-1006',
                required_reviews: { code: true }
            }, null, 2), 'utf8');
            writeTaskModeArtifactFixture(repoRoot, 'T-1006', {
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                routedTo: 'AGENTS.md',
                executionProviderSource: 'provider_entrypoint',
                runtimeIdentityStatus: 'resolved'
            });
            fs.writeFileSync(path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'), JSON.stringify({
                enabled: false
            }, null, 2), 'utf8');
            const outputPath = path.join(orchestratorRoot, 'runtime', 'reviews', 'T-1006-code-review-context.json');
            const lockPath = `${outputPath}.lock`;
            fs.mkdirSync(lockPath, { recursive: true });
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                created_at_utc: new Date().toISOString()
            }, null, 2) + '\n', 'utf8');

            assert.throws(
                () => buildReviewContext({
                    reviewType: 'code',
                    depth: 2,
                    preflightPath,
                    tokenEconomyConfigPath: path.join(orchestratorRoot, 'live', 'config', 'token-economy.json'),
                    scopedDiffMetadataPath: '',
                    outputPath,
                    repoRoot
                }),
                /Timed out acquiring file lock/
            );
            assert.equal(fs.existsSync(outputPath), false);
            assert.equal(fs.existsSync(outputPath.replace(/\.json$/, '.md')), false);

            fs.rmSync(repoRoot, { recursive: true, force: true });
        });
});
