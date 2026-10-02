import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runInstall } from '../../../src/materialization/install';
import {
    ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION,
    buildProviderOrchestratorAgentContent
} from '../../../src/materialization/content-builders';
import {
    findRepoRoot,
    setupTestWorkspace,
    writeInitAnswers
} from './install-workspace-builder';

function assertPhaseResumeContract(content: string): void {
    assert.match(content, /context_selection\.controller_read_set/);
    assert.match(content, /context_selection\.navigator_command/);
    assert.match(content, /before_code_edit_read_set/);
    assert.match(content, /unknown or stale.*implementation context/);
    assert.match(content, /missing section.*full source/);
    assert.match(content, /RULE_PACK_LOADED.*session knowledge/);
    assert.match(content, /reviewer repository-rule read sets remain empty/);
    assert.match(content, /exact prepared launch input/);
    assert.match(content, /canonical audit and verbatim final-report order/);
}

describe('runInstall — provider bridges and start-task router', () => {
    const repoRoot = findRepoRoot();

    it('keeps the resume contract in the Windsurf and Junie generated profiles', () => {
        for (const [label, bridge] of [['Windsurf', '.windsurf/agents/orchestrator.md'], ['Junie', '.junie/agents/orchestrator.md']]) {
            assertPhaseResumeContract(buildProviderOrchestratorAgentContent(label, 'AGENTS.md', bridge));
        }
    });

    it('creates provider bridges when GitHubCopilot is active', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'code-review.md')));
            assert.ok(fs.existsSync(path.join(projectRoot, '.github', 'agents', 'reviewer.md')));
            const orchestratorBridge = fs.readFileSync(path.join(projectRoot, '.github', 'agents', 'orchestrator.md'), 'utf8');
            assertPhaseResumeContract(orchestratorBridge);
            const apiBridge = fs.readFileSync(path.join(projectRoot, '.github', 'agents', 'api-review.md'), 'utf8');
            const infraBridge = fs.readFileSync(path.join(projectRoot, '.github', 'agents', 'infra-review.md'), 'utf8');
            assert.ok(orchestratorBridge.includes('dependent downstream reviewer'));
            assert.ok(orchestratorBridge.includes('upstream accepted findings receipt reports findings-satisfied'));
            assert.ok(orchestratorBridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(orchestratorBridge.includes('ReviewLaunchableBatch'));
            assert.ok(orchestratorBridge.includes('BlockedReviewLanes'));
            assert.ok(orchestratorBridge.includes('live/config/review-catalog.json'));
            assert.ok(orchestratorBridge.includes('absence remains legacy-compatible'));
            assert.ok(orchestratorBridge.includes('immutable current-task catalog/policy snapshot'));
            assert.ok(orchestratorBridge.includes('do not load the full catalog into agent context'));
            assert.ok(apiBridge.includes('api-contract-review'));
            assert.ok(apiBridge.includes('current generated launch input and immutable task snapshot'));
            assert.ok(apiBridge.includes('do not load the full review catalog into reviewer context'));
            assert.ok(infraBridge.includes('devops-k8s'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates the shared start-task router for root entrypoint providers too', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Codex',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex',
                initAnswersPath: answersPath
            });

            const workflowPath = path.join(projectRoot, '.agents', 'workflows', 'start-task.md');
            const entrypointPath = path.join(projectRoot, 'AGENTS.md');
            assert.ok(fs.existsSync(workflowPath));
            const workflow = fs.readFileSync(workflowPath, 'utf8');
            const entrypoint = fs.readFileSync(entrypointPath, 'utf8');
            assert.ok(workflow.includes('shared start-task router'));
            assert.ok(workflow.includes('Do not spawn or pre-launch a dependent downstream reviewer'));
            assert.ok(workflow.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(workflow.includes('ReviewLaunchableBatch'));
            assert.ok(workflow.includes('BlockedReviewLanes'));
            assert.ok(entrypoint.includes('.agents/workflows/start-task.md'));
            assert.ok(entrypoint.includes('immutable current-task review snapshot'));
            assert.ok(entrypoint.includes('must not load the full optional `review-catalog.json`'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates Antigravity bridge checklist workflow when Antigravity is active', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Antigravity',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Antigravity',
                initAnswersPath: answersPath
            });

            const bridgePath = path.join(projectRoot, '.antigravity', 'agents', 'orchestrator.md');
            const workflowPath = path.join(projectRoot, '.agents', 'workflows', 'start-task.md');
            assert.ok(fs.existsSync(bridgePath));
            assert.ok(fs.existsSync(workflowPath));
            const bridge = fs.readFileSync(bridgePath, 'utf8');
            assertPhaseResumeContract(bridge);
            const workflow = fs.readFileSync(workflowPath, 'utf8');
            assert.ok(bridge.includes('.agents/workflows/start-task.md'));
            assert.ok(bridge.includes(ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION));
            assert.ok(bridge.includes('do not write review output files'));
            assert.ok(bridge.includes('do not invent reviewer launch routing, telemetry, receipts, or review artifacts'));
            assert.ok(bridge.includes('dependent downstream reviewer'));
            assert.ok(bridge.includes('upstream accepted findings receipt reports findings-satisfied'));
            assert.ok(bridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(bridge.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(bridge.includes('build:node-foundation'));
            assert.ok(workflow.includes('gate enter-task-mode'));
            assert.ok(workflow.includes('gate completion-gate'));
            assert.ok(workflow.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(workflow.includes('build:node-foundation'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('refreshes stale managed Antigravity missing-reviewer-tool hard stop on rerun install', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'Antigravity',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Antigravity',
                initAnswersPath: answersPath
            });

            const bridgePath = path.join(projectRoot, '.antigravity', 'agents', 'orchestrator.md');
            const staleBridge = fs.readFileSync(bridgePath, 'utf8')
                .replace(ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION, 'Antigravity may write a local review note if no reviewer tool is available.');
            assert.ok(staleBridge.includes('Antigravity may write a local review note'));
            assert.ok(!staleBridge.includes(ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION));
            fs.writeFileSync(bridgePath, staleBridge, 'utf8');

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Antigravity',
                initAnswersPath: answersPath
            });

            const refreshedBridge = fs.readFileSync(bridgePath, 'utf8');
            assert.ok(refreshedBridge.includes(ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION));
            assert.ok(!refreshedBridge.includes('Antigravity may write a local review note'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('refreshes stale managed dependent-reviewer wording on rerun install', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const answersPath = writeInitAnswers(bundleRoot, {
                AssistantLanguage: 'English',
                AssistantBrevity: 'concise',
                SourceOfTruth: 'GitHubCopilot',
                EnforceNoAutoCommit: 'false',
                ClaudeOrchestratorFullAccess: 'false',
                TokenEconomyEnabled: 'true',
                CollectedVia: 'CLI_NONINTERACTIVE'
            });

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            const bridgePath = path.join(projectRoot, '.github', 'agents', 'orchestrator.md');
            const workflowPath = path.join(projectRoot, '.agents', 'workflows', 'start-task.md');
            const staleBridge = fs.readFileSync(bridgePath, 'utf8')
                .replace(
                    'Dependency order is a launch-time contract even on delegation-capable platforms: do not launch a dependent downstream reviewer before the required upstream accepted findings receipt reports findings-satisfied for the same cycle.',
                    'Treat downstream `test` review as dependency-ordered even on delegation-capable platforms; do not fan it out in parallel with required upstream non-`test` reviews.'
                )
                .replace(
                    'Parallel reviewer fan-out is allowed only between independent review types with no dependency edge for the current cycle.',
                    'Do not treat downstream reviewers as speculative sidecars.'
                )
                .replace(
                    'Do not fan out known producer-consumer validation commands as raw shell sidecars around the gate flow. Flows such as `npm run build:node-foundation` -> direct `node --test .node-build/...` must use the guarded workflow path or run strictly sequentially, never in parallel.',
                    'Treat generated-artifact validation as best-effort shell fan-out and let local runners coordinate freshness opportunistically.'
                );
            const staleWorkflow = fs.readFileSync(workflowPath, 'utf8')
                .replace(
                    '- Do not spawn or pre-launch a dependent downstream reviewer before the required upstream accepted findings receipt reports findings-satisfied for the same cycle.',
                    '- Do not spawn downstream `test` reviewers before upstream code review finishes.'
                )
                .replace(
                    '- Parallel reviewer fan-out is allowed only between independent review types with no dependency edge.',
                    '- Do not parallelize dependent reviews.'
                )
                .replace(
                    '- Do not fan out known producer-consumer validation commands as raw shell sidecars. Flows such as `npm run build:node-foundation` -> direct `node --test .node-build/...` must use the guarded workflow path or run strictly sequentially, never in parallel.',
                    '- Treat generated-artifact validation fan-out as acceptable when it is only local shell coordination.'
                );
            assert.notEqual(staleBridge, fs.readFileSync(bridgePath, 'utf8'));
            assert.ok(staleBridge.includes('Treat downstream `test` review as dependency-ordered even on delegation-capable platforms'));
            assert.ok(staleBridge.includes('Do not treat downstream reviewers as speculative sidecars.'));
            assert.ok(!staleBridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(staleBridge.includes('Treat generated-artifact validation as best-effort shell fan-out'));
            assert.notEqual(staleWorkflow, fs.readFileSync(workflowPath, 'utf8'));
            assert.ok(staleWorkflow.includes('Do not spawn downstream `test` reviewers before upstream code review finishes.'));
            assert.ok(staleWorkflow.includes('Do not parallelize dependent reviews.'));
            assert.ok(!staleWorkflow.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(staleWorkflow.includes('Treat generated-artifact validation fan-out as acceptable'));
            fs.writeFileSync(bridgePath, staleBridge, 'utf8');
            fs.writeFileSync(workflowPath, staleWorkflow, 'utf8');

            runInstall({
                targetRoot: projectRoot,
                bundleRoot,
                runInit: false,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'GitHubCopilot',
                initAnswersPath: answersPath
            });

            const refreshedBridge = fs.readFileSync(bridgePath, 'utf8');
            const refreshedWorkflow = fs.readFileSync(workflowPath, 'utf8');
            assert.ok(refreshedBridge.includes('dependent downstream reviewer'));
            assert.ok(refreshedBridge.includes('upstream accepted findings receipt reports findings-satisfied'));
            assert.ok(refreshedBridge.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(refreshedBridge.includes('ReviewLaunchableBatch'));
            assert.ok(refreshedBridge.includes('BlockedReviewLanes'));
            assert.ok(refreshedBridge.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(refreshedBridge.includes('build:node-foundation'));
            assert.ok(refreshedWorkflow.includes('Do not spawn or pre-launch a dependent downstream reviewer'));
            assert.ok(refreshedWorkflow.includes('Parallel reviewer fan-out is allowed only between independent review types'));
            assert.ok(refreshedWorkflow.includes('ReviewLaunchableBatch'));
            assert.ok(refreshedWorkflow.includes('BlockedReviewLanes'));
            assert.ok(refreshedWorkflow.includes('failed current reviews take remediation priority'));
            assert.ok(refreshedWorkflow.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
            assert.ok(refreshedWorkflow.includes('build:node-foundation'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});
