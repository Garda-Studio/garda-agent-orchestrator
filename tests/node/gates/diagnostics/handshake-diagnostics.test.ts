import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    buildHandshakeDiagnostics,
    formatHandshakeDiagnosticsResult,
    getHandshakeEvidence,
    getHandshakeEvidenceViolations,
    resolveHandshakeArtifactPath,
    type HandshakeDiagnosticsArtifact
} from '../../../../src/gates/diagnostics/handshake-diagnostics';
import { buildTaskModeArtifact } from '../../../../src/gates/task-mode';
import { getProviderIds } from '../../../../src/core/provider-registry';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-handshake-test-'));
}

function removeTempDir(dirPath: string): void {
    fs.rmSync(dirPath, { recursive: true, force: true });
}

function scaffoldWorkspace(root: string, options: {
    sourceCheckout?: boolean;
    entrypoint?: string;
    bridge?: string;
    startTaskRouter?: boolean;
    canonicalSourceOfTruth?: string;
} = {}): void {
    if (options.sourceCheckout) {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.writeFileSync(path.join(root, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0', 'utf8');
    }
    if (options.entrypoint) {
        const entrypointPath = path.join(root, options.entrypoint);
        fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
        fs.writeFileSync(entrypointPath, '# Entrypoint', 'utf8');
    }
    if (options.bridge) {
        const bridgePath = path.join(root, options.bridge);
        fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
        fs.writeFileSync(bridgePath, '# Bridge', 'utf8');
    }
    if (options.startTaskRouter !== false) {
        const routerPath = path.join(root, '.agents', 'workflows', 'start-task.md');
        fs.mkdirSync(path.dirname(routerPath), { recursive: true });
        fs.writeFileSync(routerPath, '# Start task router', 'utf8');
    }
    if (options.canonicalSourceOfTruth) {
        const initAnswersPath = path.join(root, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
        fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
        fs.writeFileSync(initAnswersPath, JSON.stringify({
            SourceOfTruth: options.canonicalSourceOfTruth
        }, null, 2), 'utf8');
    }
}

describe('gates/handshake-diagnostics', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = createTempDir();
    });

    afterEach(() => {
        removeTempDir(tempDir);
    });

    describe('buildHandshakeDiagnostics', () => {
        it('produces PASS for a complete GitHubCopilot source-checkout workspace', () => {
            scaffoldWorkspace(tempDir, {
                sourceCheckout: true,
                entrypoint: '.github/copilot-instructions.md',
                bridge: '.github/agents/orchestrator.md',
                startTaskRouter: true,
                canonicalSourceOfTruth: 'GitHubCopilot'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-01',
                repoRoot: tempDir,
                provider: 'GitHubCopilot',
                providerBridge: '.github/agents/orchestrator.md'
            });

            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.equal(result.task_id, 'T-TEST-01');
            assert.equal(result.provider, 'GitHubCopilot');
            assert.equal(result.execution_provider, 'GitHubCopilot');
            assert.equal(result.canonical_source_of_truth, 'GitHubCopilot');
            assert.equal(result.canonical_entrypoint, '.github/copilot-instructions.md');
            assert.equal(result.canonical_entrypoint_exists, true);
            assert.equal(result.provider_bridge, '.github/agents/orchestrator.md');
            assert.equal(result.provider_bridge_exists, true);
            assert.equal(result.execution_provider_source, 'provider_bridge');
            assert.equal(result.runtime_identity_status, 'resolved');
            assert.equal(result.reviewer_subagent_launch_status, 'launchable');
            assert.equal(result.start_task_router_exists, true);
            assert.equal(result.execution_context, 'source-checkout');
            assert.equal(result.cli_path, 'node bin/garda.js');
            assert.equal(result.violations.length, 0);
            assert.equal(result.schema_version, 1);
            assert.equal(result.event_source, 'handshake-diagnostics');
        });

        it('produces PASS for Claude root-entrypoint-only workspace', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: 'CLAUDE.md',
                startTaskRouter: true,
                canonicalSourceOfTruth: 'Claude'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-02',
                repoRoot: tempDir,
                provider: 'Claude',
                routedTo: 'CLAUDE.md'
            });

            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.equal(result.provider, 'Claude');
            assert.equal(result.execution_provider, 'Claude');
            assert.equal(result.canonical_source_of_truth, 'Claude');
            assert.equal(result.canonical_entrypoint, 'CLAUDE.md');
            assert.equal(result.canonical_entrypoint_exists, true);
            assert.equal(result.provider_bridge, null);
            assert.equal(result.provider_bridge_exists, false);
            assert.equal(result.execution_provider_source, 'provider_entrypoint');
            assert.equal(result.runtime_identity_status, 'resolved');
            assert.equal(result.reviewer_subagent_launch_status, 'launchable');
            assert.equal(result.execution_context, 'materialized-bundle');
        });

        it('reports PASS when a bridge-based provider uses its root entrypoint', () => {
            scaffoldWorkspace(tempDir, {
                sourceCheckout: true,
                entrypoint: '.github/copilot-instructions.md',
                bridge: '.github/agents/orchestrator.md',
                startTaskRouter: true,
                canonicalSourceOfTruth: 'GitHubCopilot'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-02C',
                repoRoot: tempDir,
                provider: 'GitHubCopilot',
                routedTo: '.github/copilot-instructions.md'
            });

            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.equal(result.execution_provider_source, 'provider_entrypoint');
            assert.equal(result.runtime_identity_status, 'resolved');
            assert.equal(result.reviewer_subagent_launch_status, 'launchable');
            assert.equal(result.reviewer_subagent_launch_route, '.github/copilot-instructions.md');
            assert.equal(result.violations.length, 0);
        });

        it('produces PASS when canonical SourceOfTruth and execution provider intentionally differ', () => {
            scaffoldWorkspace(tempDir, {
                sourceCheckout: true,
                entrypoint: 'AGENTS.md',
                bridge: '.antigravity/agents/orchestrator.md',
                startTaskRouter: true,
                canonicalSourceOfTruth: 'Codex'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-02B',
                repoRoot: tempDir,
                provider: 'Antigravity',
                providerBridge: '.antigravity/agents/orchestrator.md'
            });

            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.equal(result.provider, 'Antigravity');
            assert.equal(result.execution_provider, 'Antigravity');
            assert.equal(result.canonical_source_of_truth, 'Codex');
            assert.equal(result.canonical_entrypoint, 'AGENTS.md');
            assert.equal(result.provider_bridge, '.antigravity/agents/orchestrator.md');
            assert.equal(result.provider_bridge_exists, true);
            assert.equal(result.execution_provider_source, 'provider_bridge');
            assert.equal(result.runtime_identity_status, 'resolved');
            assert.equal(result.reviewer_subagent_launch_status, 'launchable');
            assert.equal(result.execution_context, 'source-checkout');
            assert.equal(result.violations.length, 0);
        });

        it('reports FAIL when canonical entrypoint is missing', () => {
            scaffoldWorkspace(tempDir, {
                startTaskRouter: true,
                canonicalSourceOfTruth: 'Windsurf'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-03',
                repoRoot: tempDir,
                provider: 'Windsurf'
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.equal(result.canonical_entrypoint_exists, false);
            assert.ok(result.violations.some(v => v.includes('.windsurf/rules/rules.md')));
        });

        it('reports FAIL when start-task router is missing', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: 'AGENTS.md',
                startTaskRouter: false,
                canonicalSourceOfTruth: 'Codex'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-04',
                repoRoot: tempDir,
                provider: 'Codex'
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.equal(result.start_task_router_exists, false);
            assert.ok(result.violations.some(v => v.includes('start-task')));
        });

        it('uses materialized-bundle context when not source checkout', () => {
            scaffoldWorkspace(tempDir, {
                sourceCheckout: false,
                entrypoint: 'GEMINI.md',
                startTaskRouter: true
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-05',
                repoRoot: tempDir,
                provider: 'Gemini'
            });

            assert.equal(result.execution_context, 'materialized-bundle');
            assert.equal(result.cli_path, 'node garda-agent-orchestrator/bin/garda.js');
        });

        it('records all supported registry providers', () => {
            for (const provider of getProviderIds()) {
                const providerDir = createTempDir();
                try {
                    scaffoldWorkspace(providerDir, {
                        startTaskRouter: true,
                        canonicalSourceOfTruth: provider
                    });
                    const result = buildHandshakeDiagnostics({
                        taskId: 'T-TEST-06',
                        repoRoot: providerDir,
                        provider
                    });
                    assert.equal(result.provider, provider, `Provider family should match for ${provider}`);
                    assert.equal(result.execution_provider, provider, `Execution provider should match for ${provider}`);
                    assert.equal(result.canonical_source_of_truth, provider, `Canonical provider should match for ${provider}`);
                    assert.equal(result.execution_provider_source, 'explicit_provider', `Identity source should stay explicit for ${provider}`);
                    assert.equal(result.runtime_identity_status, 'resolved', `Runtime identity should resolve for ${provider}`);
                    assert.ok(result.canonical_entrypoint, `Should resolve entrypoint for ${provider}`);
                } finally {
                    removeTempDir(providerDir);
                }
            }
        });

        it('fails when runtime identity is missing', () => {
            scaffoldWorkspace(tempDir, { startTaskRouter: true });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-07',
                repoRoot: tempDir,
                provider: null
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.provider, null);
            assert.equal(result.canonical_entrypoint, null);
            assert.equal(result.runtime_identity_status, 'missing');
            assert.ok(result.diagnostics.some(d => d.check === 'runtime_identity' && d.status === 'error'));
        });

        it('fails when canonical SourceOfTruth is missing even if runtime provider is explicit', () => {
            scaffoldWorkspace(tempDir, { startTaskRouter: true });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-07B',
                repoRoot: tempDir,
                provider: 'Codex'
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.execution_provider, 'Codex');
            assert.equal(result.canonical_source_of_truth, null);
            assert.ok(result.violations.some(v => v.includes('Canonical SourceOfTruth is missing')));
            assert.ok(result.diagnostics.some(d => d.check === 'canonical_source_of_truth' && d.status === 'error'));
        });

        it('records explicit cliPath and effectiveCwd overrides and fails on cli_path mismatch', () => {
            scaffoldWorkspace(tempDir, {
                startTaskRouter: true,
                canonicalSourceOfTruth: 'Claude'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-08',
                repoRoot: tempDir,
                provider: 'Claude',
                cliPath: 'node custom/path.js',
                effectiveCwd: '/custom/cwd'
            });

            assert.equal(result.cli_path, 'node custom/path.js');
            assert.equal(result.effective_cwd, '/custom/cwd');
            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.ok(result.violations.some(v => v.includes('CLI path mismatch')));
            assert.ok(result.diagnostics.some(d => d.check === 'cli_path' && d.status === 'error'));
        });

        it('detects Antigravity bridge', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: '.antigravity/rules.md',
                bridge: '.antigravity/agents/orchestrator.md',
                startTaskRouter: true,
                canonicalSourceOfTruth: 'Antigravity'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-09',
                repoRoot: tempDir,
                provider: 'Antigravity'
            });

            assert.equal(result.provider_bridge, '.antigravity/agents/orchestrator.md');
            assert.equal(result.provider_bridge_exists, true);
        });

        it('keeps missing provider bridge non-blocking for explicit provider sessions', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: '.github/copilot-instructions.md',
                startTaskRouter: true,
                canonicalSourceOfTruth: 'GitHubCopilot'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-10',
                repoRoot: tempDir,
                provider: 'GitHubCopilot'
            });

            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.equal(result.provider_bridge, '.github/agents/orchestrator.md');
            assert.equal(result.provider_bridge_exists, false);
            assert.ok(result.diagnostics.some((entry) => (
                entry.check === 'provider_bridge'
                && entry.status === 'warning'
            )));
            assert.ok(!result.violations.some(v => v.includes('Provider bridge') && v.includes('missing')));
        });

        it('reports FAIL when a bridge-routed runtime session is missing its provider bridge', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: '.github/copilot-instructions.md',
                startTaskRouter: true,
                canonicalSourceOfTruth: 'GitHubCopilot'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-10B',
                repoRoot: tempDir,
                routedTo: '.github/agents/orchestrator.md'
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.equal(result.provider_bridge, '.github/agents/orchestrator.md');
            assert.equal(result.provider_bridge_exists, false);
            assert.ok(result.violations.some(v => v.includes('bridge-routed runtime session')));
        });

        it('reports FAIL when reviewer subagent launchability is explicitly blocked', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: 'AGENTS.md',
                startTaskRouter: true,
                canonicalSourceOfTruth: 'Codex'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-10C',
                repoRoot: tempDir,
                provider: 'Codex',
                reviewerSubagentLaunchStatus: 'blocked',
                reviewerSubagentLaunchReason: 'Reviewer subagent launch is blocked for the active runtime session.',
                reviewerSubagentLaunchRemediation: 'Re-enter task mode with a runtime session that can launch delegated reviewer subagents.'
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.ok(result.violations.some(v => v.includes('Reviewer subagent launch is blocked')));
        });

        it('cli_path mismatch alone causes FAIL even when all other checks pass', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: 'CLAUDE.md',
                startTaskRouter: true,
                canonicalSourceOfTruth: 'Claude'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-CLIPATH-01',
                repoRoot: tempDir,
                provider: 'Claude',
                routedTo: 'CLAUDE.md',
                cliPath: 'node wrong/cli.js'
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.equal(result.violations.length, 1);
            assert.ok(result.violations[0].includes('CLI path mismatch'));
            assert.ok(result.violations[0].includes('wrong/cli.js'));
        });

        it('cli_path matching expected path does not add violations', () => {
            scaffoldWorkspace(tempDir, {
                sourceCheckout: true,
                entrypoint: 'CLAUDE.md',
                startTaskRouter: true,
                canonicalSourceOfTruth: 'Claude'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-CLIPATH-02',
                repoRoot: tempDir,
                provider: 'Claude',
                routedTo: 'CLAUDE.md',
                cliPath: 'node bin/garda.js'
            });

            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.ok(!result.violations.some(v => v.includes('CLI path')));
            assert.ok(result.diagnostics.some(d => d.check === 'cli_path' && d.status === 'ok'));
        });

        it('cli_path mismatch in materialized-bundle context uses correct expected path', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: 'AGENTS.md',
                startTaskRouter: true,
                canonicalSourceOfTruth: 'Codex'
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-CLIPATH-03',
                repoRoot: tempDir,
                provider: 'Codex',
                cliPath: 'node bin/garda.js'
            });

            assert.equal(result.execution_context, 'materialized-bundle');
            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.ok(result.violations.some(v => v.includes('CLI path mismatch') && v.includes('garda-agent-orchestrator/bin/garda.js')));
        });
    });

    describe('getHandshakeEvidence', () => {
        it('returns PASS for valid artifact', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-EVIDENCE-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Claude',
                execution_provider: 'Claude',
                canonical_source_of_truth: 'Claude',
                canonical_entrypoint: 'CLAUDE.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                routed_to: 'CLAUDE.md',
                execution_provider_source: 'provider_entrypoint',
                runtime_identity_status: 'resolved',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: 'CLAUDE.md',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-EVIDENCE-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-EVIDENCE-01');
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it('accepts route-attested legacy task_mode handshake evidence when routed_to stays on a canonical entrypoint', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-EVIDENCE-TASKMODE-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                execution_provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                canonical_entrypoint: 'AGENTS.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                routed_to: 'AGENTS.md',
                execution_provider_source: 'task_mode',
                runtime_identity_status: 'resolved',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: 'AGENTS.md',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-EVIDENCE-TASKMODE-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-EVIDENCE-TASKMODE-01');
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it('accepts legacy task_mode handshake evidence without routed_to when runtime identity is otherwise attested', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-EVIDENCE-TASKMODE-02',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                execution_provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                canonical_entrypoint: 'AGENTS.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                execution_provider_source: 'task_mode',
                runtime_identity_status: 'resolved',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: 'AGENTS.md',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-EVIDENCE-TASKMODE-02-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-EVIDENCE-TASKMODE-02');
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it('returns EVIDENCE_FILE_MISSING when no artifact exists', () => {
            const evidence = getHandshakeEvidence(tempDir, 'T-MISSING-01');
            assert.equal(evidence.evidence_status, 'EVIDENCE_FILE_MISSING');
            assert.ok(evidence.violations.length > 0);
        });

        it('returns TASK_ID_MISSING for null task id', () => {
            const evidence = getHandshakeEvidence(tempDir, null);
            assert.equal(evidence.evidence_status, 'TASK_ID_MISSING');
        });

        it('returns EVIDENCE_TASK_MISMATCH for wrong task id', () => {
            const artifact = {
                event_source: 'handshake-diagnostics',
                task_id: 'T-OTHER',
                status: 'PASSED',
                outcome: 'PASS'
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(
                path.join(reviewsDir, 'T-MISMATCH-01-handshake.json'),
                JSON.stringify(artifact),
                'utf8'
            );

            const evidence = getHandshakeEvidence(tempDir, 'T-MISMATCH-01');
            assert.equal(evidence.evidence_status, 'EVIDENCE_TASK_MISMATCH');
        });

        it('returns EVIDENCE_TIMELINE_UNBOUND when timeline lacks HANDSHAKE_DIAGNOSTICS_RECORDED', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-TIMELINE-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Claude',
                execution_provider: 'Claude',
                canonical_source_of_truth: 'Claude',
                canonical_entrypoint: 'CLAUDE.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                routed_to: 'CLAUDE.md',
                execution_provider_source: 'provider_entrypoint',
                runtime_identity_status: 'resolved',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: 'CLAUDE.md',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-TIMELINE-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-TIMELINE-01.jsonl');
            fs.writeFileSync(timelinePath, JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: new Date().toISOString() }) + '\n', 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-TIMELINE-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
            assert.ok(evidence.violations.some(v => v.includes('HANDSHAKE_DIAGNOSTICS_RECORDED')));
        });

        it('returns EVIDENCE_TIMELINE_UNBOUND when artifact hash mismatches timeline hash', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HASH-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Claude',
                execution_provider: 'Claude',
                canonical_source_of_truth: 'Claude',
                canonical_entrypoint: 'CLAUDE.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                routed_to: 'CLAUDE.md',
                execution_provider_source: 'provider_entrypoint',
                runtime_identity_status: 'resolved',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: 'CLAUDE.md',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HASH-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HASH-01.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    timestamp_utc: '2026-04-16T09:00:00.000Z'
                }),
                JSON.stringify({
                    event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                    timestamp_utc: new Date().toISOString(),
                    details: { artifact_hash: 'wrong-hash-value' }
                })
            ].join('\n') + '\n', 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-HASH-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
            assert.ok(evidence.violations.some(v => v.includes('hash mismatch')));
        });

        it('passes for a custom events root with malformed lines before matching handshake evidence', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HASHOK-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Claude',
                execution_provider: 'Claude',
                canonical_source_of_truth: 'Claude',
                canonical_entrypoint: 'CLAUDE.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                routed_to: 'CLAUDE.md',
                execution_provider_source: 'provider_entrypoint',
                runtime_identity_status: 'resolved',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: 'CLAUDE.md',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HASHOK-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'custom-task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HASHOK-01.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    timestamp_utc: '2026-04-16T09:00:00.000Z'
                }),
                'not-json',
                JSON.stringify({
                    event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                    timestamp_utc: new Date().toISOString(),
                    details: { artifact_hash: hash }
                })
            ].join('\n') + '\n', 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-HASHOK-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it('accepts a legacy handshake artifact without launch status only when task-mode evidence corroborates launchability', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HANDSHAKE-COMPAT-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                execution_provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                canonical_entrypoint: 'AGENTS.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                routed_to: 'AGENTS.md',
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HANDSHAKE-COMPAT-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const taskModeArtifact = buildTaskModeArtifact({
                taskId: 'T-HANDSHAKE-COMPAT-01',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Validate legacy handshake compatibility against task-mode evidence.',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                reviewerCapabilityLevel: 'delegation_required',
                reviewerExpectedExecutionMode: 'delegated_subagent',
                reviewerFallbackAllowed: false,
                reviewerFallbackReasonRequired: false,
                reviewerSubagentLaunchStatus: 'launchable',
                reviewerSubagentLaunchRoute: 'AGENTS.md',
                runtimeIdentityStatus: 'resolved',
                routedTo: 'AGENTS.md'
            });
            const taskModePath = path.join(reviewsDir, 'T-HANDSHAKE-COMPAT-01-task-mode.json');
            fs.writeFileSync(
                taskModePath,
                JSON.stringify(taskModeArtifact, null, 2),
                'utf8'
            );

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HANDSHAKE-COMPAT-01.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    timestamp_utc: '2026-04-22T09:00:00.000Z',
                    details: {
                        artifact_path: taskModePath.replace(/\\/g, '/'),
                        reviewer_subagent_launch_status: 'launchable',
                        runtime_identity_status: 'resolved'
                    }
                }),
                JSON.stringify({
                    event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                    timestamp_utc: new Date().toISOString(),
                    details: { artifact_hash: hash }
                })
            ].join('\n') + '\n', 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-HANDSHAKE-COMPAT-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it('accepts legacy handshake compatibility when corroborating task-mode evidence lives at a custom path', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HANDSHAKE-COMPAT-01B',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                execution_provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                canonical_entrypoint: 'AGENTS.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                routed_to: 'AGENTS.md',
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HANDSHAKE-COMPAT-01B-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const customTaskModePath = path.join(tempDir, 'custom-artifacts', 'task-mode', 'compat-01b.json');
            fs.mkdirSync(path.dirname(customTaskModePath), { recursive: true });
            const taskModeArtifact = buildTaskModeArtifact({
                taskId: 'T-HANDSHAKE-COMPAT-01B',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Validate legacy handshake compatibility against a custom task-mode path.',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                reviewerCapabilityLevel: 'delegation_required',
                reviewerExpectedExecutionMode: 'delegated_subagent',
                reviewerFallbackAllowed: false,
                reviewerFallbackReasonRequired: false,
                reviewerSubagentLaunchStatus: 'launchable',
                reviewerSubagentLaunchRoute: 'AGENTS.md',
                runtimeIdentityStatus: 'resolved',
                routedTo: 'AGENTS.md'
            });
            fs.writeFileSync(
                customTaskModePath,
                JSON.stringify(taskModeArtifact, null, 2),
                'utf8'
            );

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HANDSHAKE-COMPAT-01B.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    timestamp_utc: '2026-04-22T09:00:00.000Z',
                    details: {
                        artifact_path: customTaskModePath.replace(/\\/g, '/'),
                        reviewer_subagent_launch_status: 'launchable',
                        runtime_identity_status: 'resolved'
                    }
                }),
                JSON.stringify({
                    event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                    timestamp_utc: new Date().toISOString(),
                    details: { artifact_hash: hash }
                })
            ].join('\n') + '\n', 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-HANDSHAKE-COMPAT-01B', {
                timelinePath,
                taskModePath: customTaskModePath
            });
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it('keeps legacy handshake artifacts without launch status invalid when task-mode evidence cannot corroborate launchability', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HANDSHAKE-COMPAT-02',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                execution_provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                canonical_entrypoint: 'AGENTS.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                routed_to: 'AGENTS.md',
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HANDSHAKE-COMPAT-02-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HANDSHAKE-COMPAT-02.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    timestamp_utc: '2026-04-22T09:00:00.000Z'
                }),
                JSON.stringify({
                    event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                    timestamp_utc: new Date().toISOString(),
                    details: { artifact_hash: hash }
                })
            ].join('\n') + '\n', 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-HANDSHAKE-COMPAT-02', { timelinePath });
            assert.equal(evidence.evidence_status, 'EVIDENCE_RUNTIME_SESSION_INVALID');
            assert.ok(evidence.violations.some((violation) => violation.includes("reviewer_subagent_launch_status is 'unknown'")));
        });

        it('does not let a later task-mode cycle revive a legacy handshake artifact that omitted launch status', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HANDSHAKE-COMPAT-03',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                execution_provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                canonical_entrypoint: 'AGENTS.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                routed_to: 'AGENTS.md',
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HANDSHAKE-COMPAT-03-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const taskModeArtifact = buildTaskModeArtifact({
                taskId: 'T-HANDSHAKE-COMPAT-03',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Ensure newer task-mode cycles do not revive old handshake evidence.',
                provider: 'Codex',
                canonicalSourceOfTruth: 'Codex',
                executionProviderSource: 'explicit_provider',
                reviewerCapabilityLevel: 'delegation_required',
                reviewerExpectedExecutionMode: 'delegated_subagent',
                reviewerFallbackAllowed: false,
                reviewerFallbackReasonRequired: false,
                reviewerSubagentLaunchStatus: 'launchable',
                reviewerSubagentLaunchRoute: 'AGENTS.md',
                runtimeIdentityStatus: 'resolved',
                routedTo: 'AGENTS.md'
            });
            const taskModePath = path.join(reviewsDir, 'T-HANDSHAKE-COMPAT-03-task-mode.json');
            fs.writeFileSync(
                taskModePath,
                JSON.stringify(taskModeArtifact, null, 2),
                'utf8'
            );

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HANDSHAKE-COMPAT-03.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    timestamp_utc: '2026-04-22T09:00:00.000Z',
                    details: {
                        artifact_path: taskModePath.replace(/\\/g, '/'),
                        reviewer_subagent_launch_status: 'launchable',
                        runtime_identity_status: 'resolved'
                    }
                }),
                JSON.stringify({
                    event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                    timestamp_utc: '2026-04-22T09:01:00.000Z',
                    details: { artifact_hash: hash }
                }),
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    timestamp_utc: '2026-04-22T09:02:00.000Z',
                    details: {
                        artifact_path: taskModePath.replace(/\\/g, '/'),
                        reviewer_subagent_launch_status: 'launchable',
                        runtime_identity_status: 'resolved'
                    }
                })
            ].join('\n') + '\n', 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-HANDSHAKE-COMPAT-03', { timelinePath });
            assert.equal(evidence.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
            assert.ok(evidence.violations.some((violation) => violation.includes('predates the latest TASK_MODE_ENTERED')));
        });

        it('accepts bridge-based provider artifacts that claim provider_entrypoint launchability via the root entrypoint', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HASH-BRIDGE-ENTRYPOINT-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'GitHubCopilot',
                execution_provider: 'GitHubCopilot',
                canonical_source_of_truth: 'GitHubCopilot',
                canonical_entrypoint: '.github/copilot-instructions.md',
                canonical_entrypoint_exists: true,
                provider_bridge: '.github/agents/orchestrator.md',
                provider_bridge_exists: true,
                routed_to: '.github/copilot-instructions.md',
                execution_provider_source: 'provider_entrypoint',
                runtime_identity_status: 'resolved',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: '.github/copilot-instructions.md',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HASH-BRIDGE-ENTRYPOINT-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HASH-BRIDGE-ENTRYPOINT-01.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    timestamp_utc: '2026-04-16T09:00:00.000Z'
                }),
                JSON.stringify({
                    event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                    timestamp_utc: new Date().toISOString(),
                    details: { artifact_hash: hash }
                })
            ].join('\n') + '\n', 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-HASH-BRIDGE-ENTRYPOINT-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it('uses the latest HANDSHAKE_DIAGNOSTICS_RECORDED event when the gate is rerun', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HASHLATEST-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Claude',
                execution_provider: 'Claude',
                canonical_source_of_truth: 'Claude',
                canonical_entrypoint: 'CLAUDE.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                routed_to: 'CLAUDE.md',
                execution_provider_source: 'provider_entrypoint',
                runtime_identity_status: 'resolved',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: 'CLAUDE.md',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HASHLATEST-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HASHLATEST-01.jsonl');
            fs.writeFileSync(
                timelinePath,
                [
                    JSON.stringify({
                        event_type: 'TASK_MODE_ENTERED',
                        timestamp_utc: '2026-04-16T09:00:00.000Z'
                    }),
                    JSON.stringify({
                        event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                        timestamp_utc: '2026-04-03T10:00:00.000Z',
                        details: { artifact_hash: 'old-stale-hash' }
                    }),
                    JSON.stringify({
                        event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                        timestamp_utc: '2026-04-03T10:05:00.000Z',
                        details: { artifact_hash: hash }
                    })
                ].join('\n') + '\n',
                'utf8'
            );

            const evidence = getHandshakeEvidence(tempDir, 'T-HASHLATEST-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it('rejects handshake evidence when a newer task-mode cycle already superseded it', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HANDSHAKE-STALE-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                execution_provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                canonical_entrypoint: 'AGENTS.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved',
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HANDSHAKE-STALE-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HANDSHAKE-STALE-01.jsonl');
            fs.writeFileSync(
                timelinePath,
                [
                    JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-04-16T09:00:00.000Z' }),
                    JSON.stringify({
                        event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                        timestamp_utc: '2026-04-16T09:01:00.000Z',
                        details: { artifact_hash: hash }
                    }),
                    JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-04-16T09:02:00.000Z' })
                ].join('\n') + '\n',
                'utf8'
            );

            const evidence = getHandshakeEvidence(tempDir, 'T-HANDSHAKE-STALE-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
            assert.ok(evidence.violations.some((violation) => violation.includes('predates the latest TASK_MODE_ENTERED')));
        });

    });

    describe('getHandshakeEvidenceViolations', () => {
        it('returns empty array for PASS status', () => {
            const result = getHandshakeEvidenceViolations({
                task_id: 'T-01',
                evidence_path: '/test',
                evidence_hash: 'abc',
                evidence_status: 'PASS',
                provider: 'Claude',
                violations: []
            });
            assert.deepEqual(result, []);
        });

        it('returns violations for EVIDENCE_FILE_MISSING', () => {
            const result = getHandshakeEvidenceViolations({
                task_id: 'T-01',
                evidence_path: '/test',
                evidence_hash: null,
                evidence_status: 'EVIDENCE_FILE_MISSING',
                provider: null,
                violations: ['Handshake diagnostics evidence missing: file not found at \'/test\'. Run handshake-diagnostics before implementation gates.']
            });
            assert.ok(result.length > 0);
            assert.ok(result[0].includes('missing'));
        });

        it('returns generic message for unknown status', () => {
            const result = getHandshakeEvidenceViolations({
                task_id: 'T-01',
                evidence_path: null,
                evidence_hash: null,
                evidence_status: 'UNKNOWN',
                provider: null,
                violations: []
            });
            assert.ok(result.length > 0);
            assert.ok(result[0].includes('missing or invalid'));
        });

        it('returns violations for EVIDENCE_TIMELINE_UNBOUND', () => {
            const result = getHandshakeEvidenceViolations({
                task_id: 'T-01',
                evidence_path: '/test',
                evidence_hash: 'abc123',
                evidence_status: 'EVIDENCE_TIMELINE_UNBOUND',
                provider: 'Claude',
                violations: ['Handshake diagnostics evidence is not bound to task timeline for \'T-01\'.']
            });
            assert.ok(result.length > 0);
            assert.ok(result[0].includes('not bound'));
        });
    });

    describe('formatHandshakeDiagnosticsResult', () => {
        it('formats PASSED result correctly', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-FMT-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'GitHubCopilot',
                canonical_entrypoint: '.github/copilot-instructions.md',
                canonical_entrypoint_exists: true,
                provider_bridge: '.github/agents/orchestrator.md',
                provider_bridge_exists: true,
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [
                    { check: 'canonical_entrypoint', status: 'ok', detail: 'Exists.' }
                ],
                violations: []
            };

            const lines = formatHandshakeDiagnosticsResult(artifact);
            assert.ok(lines[0].includes('HANDSHAKE_DIAGNOSTICS_PASSED'));
            assert.ok(lines.some(l => l.includes('GitHubCopilot')));
        });

        it('formats FAILED result with violations', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-FMT-02',
                status: 'FAILED',
                outcome: 'FAIL',
                provider: 'Windsurf',
                canonical_entrypoint: '.windsurf/rules/rules.md',
                canonical_entrypoint_exists: false,
                provider_bridge: '.windsurf/agents/orchestrator.md',
                provider_bridge_exists: false,
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: false,
                execution_context: 'materialized-bundle',
                cli_path: 'node garda-agent-orchestrator/bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: ['Missing entrypoint', 'Missing router']
            };

            const lines = formatHandshakeDiagnosticsResult(artifact);
            assert.ok(lines[0].includes('HANDSHAKE_DIAGNOSTICS_FAILED'));
            assert.ok(lines.some(l => l.includes('Violations:')));
        });
    });

    describe('resolveHandshakeArtifactPath', () => {
        it('generates default path when no explicit path given', () => {
            const result = resolveHandshakeArtifactPath(tempDir, 'T-PATH-01');
            assert.ok(result.includes('T-PATH-01-handshake.json'));
        });

        it('uses explicit path when provided', () => {
            const customPath = path.join(tempDir, 'custom-handshake.json');
            const result = resolveHandshakeArtifactPath(tempDir, 'T-PATH-02', customPath);
            assert.ok(result.includes('custom-handshake.json'));
        });
    });
});
