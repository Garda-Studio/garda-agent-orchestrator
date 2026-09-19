import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    buildShellSmokePreflight,
    formatShellSmokePreflightResult,
    getShellSmokeEvidence,
    getShellSmokeEvidenceViolations,
    resolveShellSmokeArtifactPath,
    type ShellSmokePreflightArtifact
} from '../../../../src/gates/diagnostics/shell-smoke-preflight';
import {
    initGitRepo as initGitFixtureRepo,
    runGitFixtureCommand
} from '../git-fixtures';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-shell-smoke-test-'));
}

async function removeTempDir(dirPath: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (true) {
        try {
            fs.rmSync(dirPath, {
                recursive: true,
                force: true
            });
            return;
        } catch (error: unknown) {
            const code = error && typeof error === 'object' && 'code' in error
                ? String((error as NodeJS.ErrnoException).code || '')
                : '';
            if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code) || Date.now() >= deadline) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
}

function scaffoldWorkspace(root: string, options: {
    sourceCheckout?: boolean;
} = {}): void {
    if (options.sourceCheckout) {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.writeFileSync(path.join(root, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0', 'utf8');
    }
    const runtimeDir = path.join(root, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
}

function initGitRepo(root: string): void {
    initGitFixtureRepo(root, {
        allowEmptyCommit: true,
        gitignoreContent: null,
        initialCommitMessage: 'init',
        stageAll: false,
        userEmail: 'garda-tests@example.invalid',
        userName: 'Garda Tests'
    });
}

function configureSlowStatusFsMonitor(root: string): void {
    const scriptPath = path.join(root, '.git', 'slow-fsmonitor');
    fs.writeFileSync(
        scriptPath,
        [
            '#!/usr/bin/env node',
            'setTimeout(() => process.exit(0), 600);'
        ].join('\n') + '\n',
        'utf8'
    );
    fs.chmodSync(scriptPath, 0o755);
    const normalizedScriptPath = scriptPath.replace(/\\/gu, '/');
    runGitFixtureCommand(root, [
        'config',
        'core.fsmonitor',
        normalizedScriptPath
    ]);
}

describe('gates/shell-smoke-preflight', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = createTempDir();
    });

    afterEach(async () => {
        await removeTempDir(tempDir);
    });

    describe('buildShellSmokePreflight', () => {
        it('produces a passing artifact for a valid source-checkout workspace', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            initGitRepo(tempDir);
            const binDir = path.join(tempDir, 'bin');
            fs.mkdirSync(binDir, { recursive: true });
            fs.writeFileSync(path.join(binDir, 'garda.js'), 'console.log("2.4.2");', 'utf8');

            const artifact = buildShellSmokePreflight({
                taskId: 'T-900',
                repoRoot: tempDir
            });

            assert.equal(artifact.schema_version, 1);
            assert.equal(artifact.event_source, 'shell-smoke-preflight');
            assert.equal(artifact.task_id, 'T-900');
            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.outcome, 'PASS');
            assert.equal(artifact.execution_context, 'source-checkout');
            assert.ok(artifact.probes.length >= 4);

            const cwdProbe = artifact.probes.find(p => p.check === 'cwd');
            assert.ok(cwdProbe);
            assert.equal(cwdProbe.status, 'ok');

            const nodeProbe = artifact.probes.find(p => p.check === 'node_version');
            assert.ok(nodeProbe);
            assert.equal(nodeProbe.status, 'ok');

            const fileReadProbe = artifact.probes.find(p => p.check === 'file_read');
            assert.ok(fileReadProbe);
            assert.equal(fileReadProbe.status, 'ok');

            const tempFileProbe = artifact.probes.find(p => p.check === 'temp_file_write_delete');
            assert.ok(tempFileProbe);
            assert.equal(tempFileProbe.status, 'ok');
            assert.ok(artifact.git_change_classification);
            assert.equal(artifact.git_change_classification.policy_id, 'eol_only_is_dirty_v1');
            assert.deepEqual(artifact.git_change_classification.ignored_eol_only_files, []);
        });

        it('records provider when specified', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            initGitRepo(tempDir);
            fs.mkdirSync(path.join(tempDir, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(tempDir, 'bin', 'garda.js'), 'console.log("2.4.2");', 'utf8');

            const artifact = buildShellSmokePreflight({
                taskId: 'T-901',
                repoRoot: tempDir,
                provider: 'GitHubCopilot'
            });

            assert.equal(artifact.provider, 'GitHubCopilot');
            assert.equal(artifact.task_id, 'T-901');
            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.outcome, 'PASS');
        });

        it('records error probes when workspace is minimal', () => {
            fs.mkdirSync(tempDir, { recursive: true });
            // No package.json, no MANIFEST.md, no VERSION, no bin/

            const artifact = buildShellSmokePreflight({
                taskId: 'T-902',
                repoRoot: tempDir
            });

            // At minimum the file_read probe should fail without known files
            const fileReadProbe = artifact.probes.find(p => p.check === 'file_read');
            assert.ok(fileReadProbe);
            assert.equal(fileReadProbe.status, 'error');
            assert.ok(artifact.violations.length > 0);
            assert.equal(artifact.outcome, 'FAIL');
        });

        it('includes elapsed_ms timing on probes', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            initGitRepo(tempDir);
            fs.mkdirSync(path.join(tempDir, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(tempDir, 'bin', 'garda.js'), 'console.log("2.4.2");', 'utf8');

            const artifact = buildShellSmokePreflight({
                taskId: 'T-903',
                repoRoot: tempDir
            });

            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.outcome, 'PASS');
            for (const probe of artifact.probes) {
                assert.ok(typeof probe.elapsed_ms === 'number', `Probe '${probe.check}' should have elapsed_ms`);
                assert.ok(probe.elapsed_ms >= 0, `Probe '${probe.check}' elapsed_ms should be non-negative`);
            }
        });

        it('bounds canonical Git classification by the remaining git-state probe timeout', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            fs.mkdirSync(path.join(tempDir, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(tempDir, 'bin', 'garda.js'), 'console.log("2.4.2");', 'utf8');
            initGitRepo(tempDir);
            configureSlowStatusFsMonitor(tempDir);
            const startedAt = Date.now();
            const artifact = buildShellSmokePreflight({
                taskId: 'T-904',
                repoRoot: tempDir,
                probeTimeoutMs: 500
            });

            const gitProbe = artifact.probes.find((probe) => probe.check === 'git_state');
            assert.ok(gitProbe);
            assert.equal(gitProbe.status, 'error');
            assert.match(gitProbe.detail, /ETIMEDOUT|timed out|timeout|failed/iu);
            assert.equal(artifact.git_change_classification, null);
            assert.ok(Date.now() - startedAt < 2_000);
        });
    });

    describe('resolveShellSmokeArtifactPath', () => {
        it('resolves default path from task id', () => {
            scaffoldWorkspace(tempDir, { sourceCheckout: true });
            const resolved = resolveShellSmokeArtifactPath(tempDir, 'T-100');
            assert.ok(resolved.includes('T-100-shell-smoke.json'));
        });

        it('uses explicit path when provided', () => {
            const explicit = path.join(tempDir, 'custom-artifact.json');
            const resolved = resolveShellSmokeArtifactPath(tempDir, 'T-100', explicit);
            assert.equal(resolved, explicit);
        });
    });

    describe('getShellSmokeEvidence', () => {
        it('returns TASK_ID_MISSING when no task id', () => {
            const result = getShellSmokeEvidence(tempDir, null);
            assert.equal(result.evidence_status, 'TASK_ID_MISSING');
        });

        it('returns EVIDENCE_FILE_MISSING when no artifact exists', () => {
            const result = getShellSmokeEvidence(tempDir, 'T-999');
            assert.equal(result.evidence_status, 'EVIDENCE_FILE_MISSING');
            assert.ok(result.violations.length > 0);
        });

        it('returns PASS for valid passing artifact', () => {
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(path.join(reviewsDir, 'T-200-shell-smoke.json'), JSON.stringify({
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'shell-smoke-preflight',
                task_id: 'T-200',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                execution_context: 'source-checkout',
                effective_cwd: tempDir,
                workspace_root: tempDir,
                probes: [],
                violations: []
            }), 'utf8');

            const result = getShellSmokeEvidence(tempDir, 'T-200');
            assert.equal(result.evidence_status, 'PASS');
            assert.equal(result.provider, 'Codex');
        });

        it('returns EVIDENCE_TASK_MISMATCH for wrong task id', () => {
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(path.join(reviewsDir, 'T-300-shell-smoke.json'), JSON.stringify({
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'shell-smoke-preflight',
                task_id: 'T-OTHER',
                status: 'PASSED',
                outcome: 'PASS',
                provider: null,
                probes: [],
                violations: []
            }), 'utf8');

            const result = getShellSmokeEvidence(tempDir, 'T-300');
            assert.equal(result.evidence_status, 'EVIDENCE_TASK_MISMATCH');
        });

        it('returns EVIDENCE_SOURCE_INVALID for wrong event source', () => {
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(path.join(reviewsDir, 'T-400-shell-smoke.json'), JSON.stringify({
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'wrong-source',
                task_id: 'T-400',
                status: 'PASSED',
                outcome: 'PASS',
                probes: [],
                violations: []
            }), 'utf8');

            const result = getShellSmokeEvidence(tempDir, 'T-400');
            assert.equal(result.evidence_status, 'EVIDENCE_SOURCE_INVALID');
        });

        it('returns EVIDENCE_TIMELINE_UNBOUND when timeline has no SHELL_SMOKE_PREFLIGHT_RECORDED event', () => {
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(path.join(reviewsDir, 'T-500-shell-smoke.json'), JSON.stringify({
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'shell-smoke-preflight',
                task_id: 'T-500',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                probes: [],
                violations: []
            }), 'utf8');

            const timelinePath = path.join(tempDir, 'T-500-timeline.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    task_id: 'T-500'
                }),
                JSON.stringify({
                    event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                    task_id: 'T-500',
                    details: { artifact_hash: 'handshake-v1' }
                })
            ].join('\n') + '\n', 'utf8');

            const result = getShellSmokeEvidence(tempDir, 'T-500', { timelinePath });
            assert.equal(result.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
            assert.ok(result.violations.some(v => v.includes('SHELL_SMOKE_PREFLIGHT_RECORDED')));
        });

        it('returns EVIDENCE_TIMELINE_UNBOUND when timeline artifact hash mismatches', () => {
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(path.join(reviewsDir, 'T-600-shell-smoke.json'), JSON.stringify({
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'shell-smoke-preflight',
                task_id: 'T-600',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                probes: [],
                violations: []
            }), 'utf8');

            const timelinePath = path.join(tempDir, 'T-600-timeline.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    task_id: 'T-600'
                }),
                JSON.stringify({
                    event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                    task_id: 'T-600',
                    details: { artifact_hash: 'handshake-v1' }
                }),
                JSON.stringify({
                    event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                    task_id: 'T-600',
                    details: { artifact_hash: 'wrong-hash-value-that-does-not-match' }
                })
            ].join('\n') + '\n', 'utf8');

            const result = getShellSmokeEvidence(tempDir, 'T-600', { timelinePath });
            assert.equal(result.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
            assert.ok(result.violations.some(v => v.includes('hash mismatch')));
        });

        it('uses the latest shell-smoke event from a custom events root after malformed lines', () => {
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-650-shell-smoke.json');
            fs.writeFileSync(artifactPath, JSON.stringify({
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'shell-smoke-preflight',
                task_id: 'T-650',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                probes: [],
                violations: []
            }), 'utf8');

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'custom-task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-650.jsonl');
            fs.writeFileSync(
                timelinePath,
                [
                    JSON.stringify({
                        event_type: 'TASK_MODE_ENTERED',
                        task_id: 'T-650',
                        timestamp_utc: '2026-04-03T09:59:00.000Z'
                    }),
                    JSON.stringify({
                        event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                        task_id: 'T-650',
                        timestamp_utc: '2026-04-03T09:59:30.000Z',
                        details: { artifact_hash: 'handshake-v1' }
                    }),
                    'not-json',
                    JSON.stringify({
                        event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                        task_id: 'T-650',
                        timestamp_utc: '2026-04-03T10:00:00.000Z',
                        details: { artifact_hash: 'old-stale-hash' }
                    }),
                    JSON.stringify({
                        event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                        task_id: 'T-650',
                        timestamp_utc: '2026-04-03T10:05:00.000Z',
                        details: { artifact_hash: hash }
                    })
                ].join('\n') + '\n',
                'utf8'
            );

            const result = getShellSmokeEvidence(tempDir, 'T-650', { timelinePath });
            assert.equal(result.evidence_status, 'PASS');
            assert.equal(result.violations.length, 0);
        });

        it('rejects shell smoke evidence when a newer handshake already superseded it', () => {
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-660-shell-smoke.json');
            fs.writeFileSync(artifactPath, JSON.stringify({
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'shell-smoke-preflight',
                task_id: 'T-660',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                probes: [],
                violations: []
            }), 'utf8');

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelinePath = path.join(tempDir, 'T-660-timeline.jsonl');
            fs.writeFileSync(
                timelinePath,
                [
                    JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-04-16T09:00:00.000Z' }),
                    JSON.stringify({
                        event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                        timestamp_utc: '2026-04-16T09:01:00.000Z',
                        details: { artifact_hash: 'handshake-v1' }
                    }),
                    JSON.stringify({
                        event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                        timestamp_utc: '2026-04-16T09:02:00.000Z',
                        details: { artifact_hash: hash }
                    }),
                    JSON.stringify({
                        event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                        timestamp_utc: '2026-04-16T09:03:00.000Z',
                        details: { artifact_hash: 'handshake-v2' }
                    })
                ].join('\n') + '\n',
                'utf8'
            );

            const result = getShellSmokeEvidence(tempDir, 'T-660', { timelinePath });
            assert.equal(result.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
            assert.ok(result.violations.some((violation) => violation.includes('Unsafe same-task overlap detected')));
        });

    });

    describe('getShellSmokeEvidenceViolations', () => {
        it('returns empty for PASS status', () => {
            const violations = getShellSmokeEvidenceViolations({
                task_id: 'T-100',
                evidence_path: '/path',
                evidence_hash: 'abc',
                evidence_status: 'PASS',
                provider: 'Codex',
                violations: []
            });
            assert.deepEqual(violations, []);
        });

        it('returns fallback message for UNKNOWN status', () => {
            const violations = getShellSmokeEvidenceViolations({
                task_id: 'T-100',
                evidence_path: null,
                evidence_hash: null,
                evidence_status: 'UNKNOWN',
                provider: null,
                violations: []
            });
            assert.ok(violations.length > 0);
            assert.ok(violations[0].includes('shell-smoke-preflight'));
        });
    });

    describe('formatShellSmokePreflightResult', () => {
        it('formats a passing artifact', () => {
            const artifact: ShellSmokePreflightArtifact = {
                schema_version: 1,
                timestamp_utc: '2026-04-02T00:00:00.000Z',
                event_source: 'shell-smoke-preflight',
                task_id: 'T-100',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                execution_context: 'source-checkout',
                effective_cwd: '/repo',
                workspace_root: '/repo',
                probes: [
                    { check: 'cwd', status: 'ok', detail: 'cwd=/repo', elapsed_ms: 1 },
                    { check: 'node_version', status: 'ok', detail: 'node=v20.0.0', elapsed_ms: 50 }
                ],
                violations: []
            };

            const lines = formatShellSmokePreflightResult(artifact);
            assert.ok(lines[0].includes('SHELL_SMOKE_PREFLIGHT_PASSED'));
            assert.ok(lines.some(l => l.includes('Codex')));
            assert.ok(lines.some(l => l.includes('[+] cwd')));
        });

        it('formats a failing artifact with violations', () => {
            const artifact: ShellSmokePreflightArtifact = {
                schema_version: 1,
                timestamp_utc: '2026-04-02T00:00:00.000Z',
                event_source: 'shell-smoke-preflight',
                task_id: 'T-100',
                status: 'FAILED',
                outcome: 'FAIL',
                provider: null,
                execution_context: 'materialized-bundle',
                effective_cwd: '/repo',
                workspace_root: '/repo',
                probes: [
                    { check: 'cwd', status: 'ok', detail: 'cwd=/repo', elapsed_ms: 1 },
                    { check: 'file_read', status: 'error', detail: 'No readable file', elapsed_ms: 2 }
                ],
                violations: ["Probe 'file_read' failed: No readable file"]
            };

            const lines = formatShellSmokePreflightResult(artifact);
            assert.ok(lines[0].includes('SHELL_SMOKE_PREFLIGHT_FAILED'));
            assert.ok(lines.some(l => l.includes('[-] file_read')));
            assert.ok(lines.some(l => l.includes('Violations:')));
        });
    });
});
