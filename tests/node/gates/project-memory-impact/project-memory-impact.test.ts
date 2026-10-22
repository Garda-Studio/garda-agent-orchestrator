import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    assessProjectMemoryImpact,
    getProjectMemoryImpactLifecycleEvidence,
    routeProjectMemoryImpact
} from '../../../../src/gates/project-memory-impact';
import {
    PROJECT_MEMORY_REQUIRED_FILE_NAMES
} from '../../../../src/core/project-memory';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';

function withTempRepo(callback: (repoRoot: string) => void): void {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-pm-impact-'));
    try {
        seedProjectMemory(repoRoot);
        callback(repoRoot);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

function seedProjectMemory(repoRoot: string): void {
    const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        fs.writeFileSync(
            path.join(memoryRoot, fileName),
            `# ${fileName}\n\nDurable Garda project memory content for ${fileName}.\n`,
            'utf8'
        );
    }
}

function initializeGitRepo(repoRoot: string): void {
    childProcess.execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.email', 'garda-tests@example.com'], { cwd: repoRoot, stdio: 'ignore' });
    childProcess.execFileSync('git', ['config', 'user.name', 'Garda Tests'], { cwd: repoRoot, stdio: 'ignore' });
    childProcess.execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
    childProcess.execFileSync('git', ['commit', '-m', 'seed'], { cwd: repoRoot, stdio: 'ignore' });
}

function writeProjectMemoryWorkflowConfig(repoRoot: string): void {
    const config = buildDefaultWorkflowConfig();
    config.project_memory_maintenance.enabled = true;
    config.project_memory_maintenance.mode = 'check';
    config.project_memory_maintenance.run_before_final_closeout = true;
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function writeRawWorkflowConfig(repoRoot: string, config: Record<string, unknown>): void {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify(config, null, 2), 'utf8');
}

describe('routeProjectMemoryImpact', () => {
    it('maps durable workflow changes to focused memory files', () => {
        const routed = routeProjectMemoryImpact(['src/gates/next-step.ts']);

        assert.deepEqual(routed.affectedFileNames, [
            'commands.md',
            'compact.md',
            'decisions.md',
            'risks.md'
        ]);
        assert.equal(routed.reasons[0].changed_file, 'src/gates/next-step.ts');
    });

    it('does not recommend project memory updates for localized test-only changes', () => {
        const routed = routeProjectMemoryImpact(['tests/node/gates/project-memory-impact.test.ts']);

        assert.deepEqual(routed.affectedFileNames, []);
        assert.deepEqual(routed.reasons, []);
    });

    it('treats direct live project-memory file changes as affected memory evidence', () => {
        const routed = routeProjectMemoryImpact(['garda-agent-orchestrator/live/docs/project-memory/commands.md']);

        assert.deepEqual(routed.affectedFileNames, ['commands.md']);
        assert.deepEqual(routed.reasons[0]?.suggested_memory_files, ['commands.md']);
    });

    it('ignores nested mirror project-memory paths outside the canonical live roots', () => {
        const routed = routeProjectMemoryImpact([
            'tests/fixtures/garda-agent-orchestrator/live/docs/project-memory/commands.md'
        ]);

        assert.deepEqual(routed.affectedFileNames, []);
        assert.deepEqual(routed.reasons, []);
    });

    it('rejects noncanonical single-prefix project-memory paths', () => {
        const routed = routeProjectMemoryImpact([
            'scratch/live/docs/project-memory/commands.md'
        ]);

        assert.deepEqual(routed.affectedFileNames, []);
        assert.deepEqual(routed.reasons, []);
    });
});

describe('assessProjectMemoryImpact', () => {
    for (const mode of ['check', 'strict', 'update'] as const) {
        it(`reuses scoped task authorization without granting writes or bypassing evidence in ${mode} mode`, () => {
            withTempRepo((repoRoot) => {
                const result = assessProjectMemoryImpact({
                    repoRoot,
                    taskId: 'T-425',
                    modeOverride: mode,
                    changedFiles: ['src/gates/project-memory-impact.ts']
                });

                assert.match(result.artifact.next_step, /existing user approval or the active task instruction requiring project-memory maintenance/);
                assert.match(result.artifact.next_step, /necessary in-scope updates; do not ask again/);
                assert.match(result.artifact.next_step, /Obtain user approval before writes outside that authorization/);
                assert.match(result.artifact.next_step, /Task start, memory-file existence, or suggested candidates alone do not authorize writes/);
                assert.match(result.artifact.next_step, /--confirm-updated/);
                assert.equal(result.artifact.writes_allowed, false);
                assert.equal(result.artifact.require_user_approval_for_writes, true);
                assert.equal(result.updateEvidenceToWrite, null);
                if (mode === 'check') {
                    assert.equal(result.artifact.status, 'UPDATE_NEEDED');
                    assert.equal(result.artifact.outcome, 'PASS');
                    assert.match(result.artifact.next_step, /concrete rationale/);
                    assert.match(result.artifact.next_step, /check mode remains advisory/);
                } else {
                    assert.equal(result.artifact.status, 'BLOCKED');
                    assert.equal(result.artifact.outcome, 'FAIL');
                    assert.ok(result.artifact.update_evidence.invalid_reasons.length > 0);
                    assert.match(result.artifact.next_step, /--skip-unchanged-candidates-rationale/);
                    assert.match(result.artifact.next_step, /Authorization does not replace valid preflight or update evidence/);
                }
            });
        });
    }

    it('returns OFF when maintenance mode is off', () => {
        withTempRepo((repoRoot) => {
            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-100',
                modeOverride: 'off',
                changedFiles: ['src/gates/next-step.ts']
            });

            assert.equal(result.artifact.status, 'OFF');
            assert.equal(result.artifact.update_needed, false);
            assert.deepEqual(result.artifact.violations, []);
        });
    });

    it('returns NO_UPDATE_NEEDED for test-only changes in check mode', () => {
        withTempRepo((repoRoot) => {
            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-101',
                modeOverride: 'check',
                changedFiles: ['tests/node/gates/project-memory-impact.test.ts']
            });

            assert.equal(result.artifact.status, 'NO_UPDATE_NEEDED');
            assert.equal(result.artifact.update_needed, false);
            assert.deepEqual(result.artifact.affected_memory_files, []);
        });
    });

    it('treats directly scoped ignored project-memory files as updated evidence instead of no-update-needed', () => {
        withTempRepo((repoRoot) => {
            const commandsPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'commands.md');
            fs.appendFileSync(commandsPath, '\nScoped project-memory update.\n', 'utf8');

            const blocked = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-101a',
                modeOverride: 'strict',
                changedFiles: ['garda-agent-orchestrator/live/docs/project-memory/commands.md']
            });

            assert.equal(blocked.artifact.status, 'BLOCKED');
            assert.equal(blocked.artifact.update_needed, true);
            assert.deepEqual(blocked.artifact.affected_memory_files, [
                'garda-agent-orchestrator/live/docs/project-memory/commands.md'
            ]);

            const updated = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-101a',
                modeOverride: 'strict',
                changedFiles: ['garda-agent-orchestrator/live/docs/project-memory/commands.md'],
                confirmUpdated: true,
                updatedMemoryFiles: ['garda-agent-orchestrator/live/docs/project-memory/commands.md']
            });

            assert.equal(updated.artifact.status, 'UPDATED');
            assert.deepEqual(updated.artifact.update_evidence.updated_memory_files, [
                'garda-agent-orchestrator/live/docs/project-memory/commands.md'
            ]);
        });
    });

    it('does not treat nested mirror project-memory paths as update-needed evidence', () => {
        withTempRepo((repoRoot) => {
            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-101b',
                modeOverride: 'check',
                changedFiles: ['tests/fixtures/garda-agent-orchestrator/live/docs/project-memory/commands.md']
            });

            assert.equal(result.artifact.status, 'NO_UPDATE_NEEDED');
            assert.equal(result.artifact.update_needed, false);
            assert.deepEqual(result.artifact.affected_memory_files, []);
        });
    });

    it('blocks when neither explicit changed files nor readable preflight evidence exists', () => {
        withTempRepo((repoRoot) => {
            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-105',
                modeOverride: 'check',
                preflightPath: 'missing-preflight.json'
            });

            assert.equal(result.artifact.status, 'BLOCKED');
            assert.equal(result.artifact.outcome, 'FAIL');
            assert.ok(result.artifact.violations.some((violation) => violation.includes('Preflight artifact')));
        });
    });

    it('allows explicit empty changed files without preflight evidence', () => {
        withTempRepo((repoRoot) => {
            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-106',
                modeOverride: 'strict',
                preflightPath: 'missing-preflight.json',
                changedFiles: []
            });

            assert.equal(result.artifact.status, 'NO_UPDATE_NEEDED');
            assert.equal(result.artifact.outcome, 'PASS');
        });
    });

    it('returns UPDATE_NEEDED with suggested memory files for workflow gate changes', () => {
        withTempRepo((repoRoot) => {
            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-102',
                modeOverride: 'check',
                changedFiles: ['src/gates/project-memory-impact.ts']
            });

            assert.equal(result.artifact.status, 'UPDATE_NEEDED');
            assert.equal(result.artifact.update_needed, true);
            assert.ok(result.artifact.affected_memory_files.some((file) => file.endsWith('/risks.md')));
            assert.ok(result.artifact.affected_memory_files.some((file) => file.endsWith('/compact.md')));
        });
    });

    it('blocks strict mode when update evidence is missing', () => {
        withTempRepo((repoRoot) => {
            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-103',
                modeOverride: 'strict',
                changedFiles: ['src/lifecycle/update.ts']
            });

            assert.equal(result.artifact.status, 'BLOCKED');
            assert.equal(result.artifact.outcome, 'FAIL');
            assert.ok(result.artifact.update_evidence.invalid_reasons.length > 0);
        });
    });

    it('blocks update mode when update evidence is missing', () => {
        withTempRepo((repoRoot) => {
            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-107',
                modeOverride: 'update',
                changedFiles: ['src/gates/project-memory-impact.ts']
            });

            assert.equal(result.artifact.status, 'BLOCKED');
            assert.equal(result.artifact.outcome, 'FAIL');
            assert.ok(result.artifact.violations.some((violation) => violation.includes('Update evidence')));
        });
    });

    it('infers updated memory files from the current workspace diff when it exactly matches the affected set', () => {
        withTempRepo((repoRoot) => {
            initializeGitRepo(repoRoot);
            const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
            for (const fileName of ['commands.md', 'compact.md', 'decisions.md', 'risks.md']) {
                fs.appendFileSync(path.join(memoryRoot, fileName), '\nUpdated for T-583.\n', 'utf8');
            }

            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-111',
                modeOverride: 'strict',
                changedFiles: ['src/gates/project-memory-impact.ts'],
                confirmUpdated: true
            });

            assert.equal(result.artifact.status, 'UPDATED');
            assert.deepEqual(result.artifact.update_evidence.updated_memory_files, [
                'garda-agent-orchestrator/live/docs/project-memory/commands.md',
                'garda-agent-orchestrator/live/docs/project-memory/compact.md',
                'garda-agent-orchestrator/live/docs/project-memory/decisions.md',
                'garda-agent-orchestrator/live/docs/project-memory/risks.md'
            ]);
            assert.ok(result.updateEvidenceToWrite);
        });
    });

    it('rejects bare confirm-updated when changed project-memory files do not exactly match the affected set', () => {
        withTempRepo((repoRoot) => {
            initializeGitRepo(repoRoot);
            const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
            fs.appendFileSync(path.join(memoryRoot, 'commands.md'), '\nUpdated for T-583.\n', 'utf8');
            fs.appendFileSync(path.join(memoryRoot, 'compact.md'), '\nUpdated for T-583.\n', 'utf8');

            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-112',
                modeOverride: 'strict',
                changedFiles: ['src/gates/project-memory-impact.ts'],
                confirmUpdated: true
            });

            assert.equal(result.artifact.status, 'BLOCKED');
            assert.ok(result.artifact.violations.some((violation) => violation.includes('do not exactly match the affected list')));
            assert.equal(result.updateEvidenceToWrite, null);
        });
    });

    it('accepts partial project-memory updates when skipped candidates have a concrete rationale', () => {
        withTempRepo((repoRoot) => {
            initializeGitRepo(repoRoot);
            const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
            fs.appendFileSync(path.join(memoryRoot, 'commands.md'), '\nCurrent command guidance changed.\n', 'utf8');

            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-112b',
                modeOverride: 'strict',
                changedFiles: ['src/gates/project-memory-impact.ts'],
                confirmUpdated: true,
                skipUnchangedCandidatesRationale: 'Other candidate memory files already describe the current durable contracts; only command guidance changed.'
            });

            assert.equal(result.artifact.status, 'UPDATED');
            assert.deepEqual(result.artifact.update_evidence.updated_memory_files, [
                'garda-agent-orchestrator/live/docs/project-memory/commands.md'
            ]);
            assert.deepEqual(result.artifact.update_evidence.skipped_memory_files, [
                'garda-agent-orchestrator/live/docs/project-memory/compact.md',
                'garda-agent-orchestrator/live/docs/project-memory/decisions.md',
                'garda-agent-orchestrator/live/docs/project-memory/risks.md'
            ]);
            assert.ok(result.updateEvidenceToWrite);
        });
    });

    it('accepts persisted skipped candidate evidence only while skipped files remain unchanged', () => {
        withTempRepo((repoRoot) => {
            initializeGitRepo(repoRoot);
            const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
            fs.appendFileSync(path.join(memoryRoot, 'commands.md'), '\nCurrent command guidance changed.\n', 'utf8');

            const confirmed = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-112e',
                modeOverride: 'strict',
                changedFiles: ['src/gates/project-memory-impact.ts'],
                confirmUpdated: true,
                skipUnchangedCandidatesRationale: 'Other candidate memory files already describe the current durable contracts; only command guidance changed.'
            });
            assert.ok(confirmed.updateEvidenceToWrite);
            fs.mkdirSync(path.dirname(confirmed.updateArtifactPath), { recursive: true });
            fs.writeFileSync(confirmed.updateArtifactPath, JSON.stringify(confirmed.updateEvidenceToWrite, null, 2), 'utf8');

            const current = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-112e',
                modeOverride: 'strict',
                changedFiles: ['src/gates/project-memory-impact.ts']
            });
            assert.equal(current.artifact.status, 'UPDATED');
            assert.equal(current.artifact.update_evidence.status, 'VALID');

            fs.appendFileSync(path.join(memoryRoot, 'compact.md'), '\nSkipped candidate changed after evidence.\n', 'utf8');
            const tampered = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-112e',
                modeOverride: 'strict',
                changedFiles: ['src/gates/project-memory-impact.ts']
            });
            assert.equal(tampered.artifact.status, 'BLOCKED');
            assert.equal(tampered.artifact.update_evidence.status, 'TAMPERED');
            assert.ok(tampered.artifact.violations.some((violation) => violation.includes('Skipped memory file hash changed')));
        });
    });

    it('rejects persisted skipped candidate evidence when rationale or hashes are incomplete', () => {
        withTempRepo((repoRoot) => {
            initializeGitRepo(repoRoot);
            const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
            fs.appendFileSync(path.join(memoryRoot, 'commands.md'), '\nCurrent command guidance changed.\n', 'utf8');

            const confirmed = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-112f',
                modeOverride: 'strict',
                changedFiles: ['src/gates/project-memory-impact.ts'],
                confirmUpdated: true,
                skipUnchangedCandidatesRationale: 'Other candidate memory files already describe the current durable contracts; only command guidance changed.'
            });
            assert.ok(confirmed.updateEvidenceToWrite);
            const incompleteEvidence = {
                ...confirmed.updateEvidenceToWrite,
                skipped_file_hashes: {},
                skip_unchanged_candidates_rationale: ''
            };
            fs.mkdirSync(path.dirname(confirmed.updateArtifactPath), { recursive: true });
            fs.writeFileSync(confirmed.updateArtifactPath, JSON.stringify(incompleteEvidence, null, 2), 'utf8');

            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-112f',
                modeOverride: 'strict',
                changedFiles: ['src/gates/project-memory-impact.ts']
            });

            assert.equal(result.artifact.status, 'BLOCKED');
            assert.ok(result.artifact.violations.some((violation) => violation.includes('require --skip-unchanged-candidates-rationale')));
            assert.ok(result.artifact.violations.some((violation) => violation.includes('Skipped memory file hash changed')));
        });
    });

    it('rejects skipped project-memory candidates without a concrete rationale', () => {
        withTempRepo((repoRoot) => {
            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-112c',
                modeOverride: 'strict',
                changedFiles: ['src/gates/project-memory-impact.ts'],
                confirmUpdated: true,
                skippedMemoryFiles: ['garda-agent-orchestrator/live/docs/project-memory/commands.md'],
                skipUnchangedCandidatesRationale: 'Replace me placeholder rationale for skipped memory candidates.'
            });

            assert.equal(result.artifact.status, 'BLOCKED');
            assert.ok(result.artifact.violations.some((violation) => violation.includes('must be concrete')));
            assert.equal(result.updateEvidenceToWrite, null);
        });
    });

    it('rejects rationale-only confirmation when current project-memory diff cannot be inferred', () => {
        withTempRepo((repoRoot) => {
            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-112d',
                modeOverride: 'strict',
                changedFiles: ['src/gates/project-memory-impact.ts'],
                confirmUpdated: true,
                skipUnchangedCandidatesRationale: 'Candidate memory files already describe the current durable contracts.'
            });

            assert.equal(result.artifact.status, 'BLOCKED');
            assert.ok(result.artifact.violations.some((violation) => violation.includes('could not be inferred safely')));
            assert.equal(result.updateEvidenceToWrite, null);
        });
    });

    it('keeps compact overflow advisory when no durable update is affected', () => {
        withTempRepo((repoRoot) => {
            const compactPath = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'live',
                'docs',
                'project-memory',
                'compact.md'
            );
            fs.writeFileSync(compactPath, 'x'.repeat(13000), 'utf8');

            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId: 'T-104',
                modeOverride: 'strict',
                changedFiles: []
            });

            assert.equal(result.artifact.status, 'NO_UPDATE_NEEDED');
            assert.equal(result.artifact.outcome, 'PASS');
            assert.equal(result.artifact.compact.status, 'OVERFLOW');
            assert.ok(result.artifact.validation.issues.some((issue) => issue.message.includes('compact.md')));
        });
    });

    it('labels no-update compact overflow as non-blocking in lifecycle summaries', () => {
        withTempRepo((repoRoot) => {
            writeProjectMemoryWorkflowConfig(repoRoot);
            const taskId = 'T-104b';
            const reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ changed_files: [] }, null, 2), 'utf8');
            const compactPath = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'live',
                'docs',
                'project-memory',
                'compact.md'
            );
            fs.writeFileSync(compactPath, 'x'.repeat(13000), 'utf8');

            const result = assessProjectMemoryImpact({ repoRoot, taskId, preflightPath });
            assert.equal(result.artifact.status, 'NO_UPDATE_NEEDED');
            assert.equal(result.artifact.compact.status, 'OVERFLOW');
            fs.mkdirSync(path.dirname(result.artifactPath), { recursive: true });
            fs.writeFileSync(result.artifactPath, JSON.stringify(result.artifact, null, 2), 'utf8');

            const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId, preflightPath });
            assert.equal(evidence.evidence_status, 'CURRENT');
            assert.equal(evidence.status, 'NO_UPDATE_NEEDED');
            assert.equal(evidence.compact_status, 'OVERFLOW_NON_BLOCKING_NO_UPDATE');
            assert.equal(evidence.compact_refreshed, null);
            assert.ok(evidence.visible_summary_line.includes('compact=OVERFLOW_NON_BLOCKING_NO_UPDATE'));
            assert.ok(evidence.visible_summary_line.includes('compact_refreshed=not_required'));
            assert.equal(evidence.visible_summary_line.includes('compact=OVERFLOW; compact_refreshed=false'), false);
        });
    });

    it('ignores confirm-updated evidence when current impact resolves to no-update-needed', () => {
        withTempRepo((repoRoot) => {
            writeProjectMemoryWorkflowConfig(repoRoot);
            const taskId = 'T-104c';
            const reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ changed_files: [] }, null, 2), 'utf8');

            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId,
                preflightPath,
                confirmUpdated: true,
                updatedMemoryFiles: ['garda-agent-orchestrator/live/docs/project-memory/compact.md']
            });

            assert.equal(result.artifact.status, 'NO_UPDATE_NEEDED');
            assert.equal(result.artifact.update_evidence.status, 'NOT_REQUIRED');
            assert.deepEqual(result.artifact.update_evidence.updated_memory_files, []);
            assert.equal(result.updateEvidenceToWrite, null);

            fs.mkdirSync(path.dirname(result.artifactPath), { recursive: true });
            fs.writeFileSync(result.artifactPath, JSON.stringify(result.artifact, null, 2), 'utf8');

            const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId, preflightPath });
            assert.equal(evidence.evidence_status, 'CURRENT');
            assert.equal(evidence.status, 'NO_UPDATE_NEEDED');
            assert.equal(evidence.update_needed, false);
            assert.equal(evidence.compact_refreshed, null);
            assert.equal(evidence.violations.length, 0);
        });
    });

    it('acknowledges refreshed compact overflow in lifecycle summaries after valid update evidence', () => {
        withTempRepo((repoRoot) => {
            writeProjectMemoryWorkflowConfig(repoRoot);
            const taskId = 'T-113';
            const reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: ['src/gates/project-memory-impact.ts']
            }, null, 2), 'utf8');
            const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
            const initial = assessProjectMemoryImpact({ repoRoot, taskId, preflightPath });
            fs.mkdirSync(path.dirname(initial.artifactPath), { recursive: true });
            fs.writeFileSync(initial.artifactPath, JSON.stringify(initial.artifact, null, 2), 'utf8');
            fs.writeFileSync(path.join(memoryRoot, 'compact.md'), 'x'.repeat(13000), 'utf8');

            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId,
                preflightPath,
                confirmUpdated: true,
                updatedMemoryFiles: [
                    'garda-agent-orchestrator/live/docs/project-memory/commands.md',
                    'garda-agent-orchestrator/live/docs/project-memory/compact.md',
                    'garda-agent-orchestrator/live/docs/project-memory/decisions.md',
                    'garda-agent-orchestrator/live/docs/project-memory/risks.md'
                ]
            });
            assert.equal(result.artifact.status, 'UPDATED');
            assert.equal(result.artifact.compact.status, 'OVERFLOW');
            assert.ok(result.updateEvidenceToWrite);
            fs.mkdirSync(path.dirname(result.artifactPath), { recursive: true });
            fs.mkdirSync(path.dirname(result.updateArtifactPath), { recursive: true });
            fs.writeFileSync(result.updateArtifactPath, JSON.stringify(result.updateEvidenceToWrite, null, 2), 'utf8');
            fs.writeFileSync(result.artifactPath, JSON.stringify(result.artifact, null, 2), 'utf8');

            const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId, preflightPath });
            assert.equal(evidence.evidence_status, 'CURRENT');
            assert.equal(evidence.status, 'UPDATED');
            assert.equal(evidence.compact_status, 'REFRESHED_OVERFLOW_ACKNOWLEDGED');
            assert.equal(evidence.compact_refreshed, true);
            assert.equal(evidence.visible_summary_line.includes('compact=OVERFLOW'), false);
            assert.ok(evidence.visible_summary_line.includes('compact=REFRESHED_OVERFLOW_ACKNOWLEDGED'));
        });
    });

    it('does not mark compact refreshed only because compact.md was explicitly listed', () => {
        withTempRepo((repoRoot) => {
            writeProjectMemoryWorkflowConfig(repoRoot);
            const taskId = 'T-113b';
            const reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: ['src/gates/project-memory-impact.ts']
            }, null, 2), 'utf8');
            const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
            fs.writeFileSync(path.join(memoryRoot, 'compact.md'), 'x'.repeat(13000), 'utf8');
            const initial = assessProjectMemoryImpact({ repoRoot, taskId, preflightPath });
            fs.mkdirSync(path.dirname(initial.artifactPath), { recursive: true });
            fs.writeFileSync(initial.artifactPath, JSON.stringify(initial.artifact, null, 2), 'utf8');

            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId,
                preflightPath,
                confirmUpdated: true,
                updatedMemoryFiles: [
                    'garda-agent-orchestrator/live/docs/project-memory/commands.md',
                    'garda-agent-orchestrator/live/docs/project-memory/compact.md',
                    'garda-agent-orchestrator/live/docs/project-memory/decisions.md',
                    'garda-agent-orchestrator/live/docs/project-memory/risks.md'
                ]
            });

            assert.equal(result.artifact.status, 'UPDATED');
            assert.equal(result.updateEvidenceToWrite?.compact_refreshed, false);
            assert.ok(result.updateEvidenceToWrite);
            fs.mkdirSync(path.dirname(result.artifactPath), { recursive: true });
            fs.mkdirSync(path.dirname(result.updateArtifactPath), { recursive: true });
            fs.writeFileSync(result.updateArtifactPath, JSON.stringify(result.updateEvidenceToWrite, null, 2), 'utf8');
            fs.writeFileSync(result.artifactPath, JSON.stringify(result.artifact, null, 2), 'utf8');

            const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId, preflightPath });
            assert.equal(evidence.evidence_status, 'CURRENT');
            assert.equal(evidence.status, 'UPDATED');
            assert.equal(evidence.compact_status, 'UPDATED_OVERFLOW_NOT_REFRESHED');
            assert.equal(evidence.compact_refreshed, false);
            assert.ok(evidence.visible_summary_line.includes('compact=UPDATED_OVERFLOW_NOT_REFRESHED'));
            assert.ok(evidence.visible_summary_line.includes('compact_refreshed=not_refreshed_update_accepted'));
            assert.equal(evidence.visible_summary_line.includes('compact=OVERFLOW; compact_refreshed=false'), false);
        });
    });

    it('does not acknowledge refreshed compact overflow when lifecycle impact evidence is stale', () => {
        withTempRepo((repoRoot) => {
            writeProjectMemoryWorkflowConfig(repoRoot);
            const taskId = 'T-114';
            const reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: ['src/gates/project-memory-impact.ts']
            }, null, 2), 'utf8');
            const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
            fs.writeFileSync(path.join(memoryRoot, 'compact.md'), 'x'.repeat(13000), 'utf8');

            const result = assessProjectMemoryImpact({
                repoRoot,
                taskId,
                preflightPath,
                confirmUpdated: true,
                updatedMemoryFiles: [
                    'garda-agent-orchestrator/live/docs/project-memory/commands.md',
                    'garda-agent-orchestrator/live/docs/project-memory/compact.md',
                    'garda-agent-orchestrator/live/docs/project-memory/decisions.md',
                    'garda-agent-orchestrator/live/docs/project-memory/risks.md'
                ]
            });
            assert.equal(result.artifact.status, 'UPDATED');
            assert.ok(result.updateEvidenceToWrite);
            fs.mkdirSync(path.dirname(result.artifactPath), { recursive: true });
            fs.mkdirSync(path.dirname(result.updateArtifactPath), { recursive: true });
            fs.writeFileSync(result.updateArtifactPath, JSON.stringify(result.updateEvidenceToWrite, null, 2), 'utf8');
            fs.writeFileSync(result.artifactPath, JSON.stringify(result.artifact, null, 2), 'utf8');
            fs.writeFileSync(preflightPath, JSON.stringify({ changed_files: [] }, null, 2), 'utf8');

            const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId, preflightPath });
            assert.equal(evidence.evidence_status, 'STALE');
            assert.equal(evidence.status, 'UPDATED');
            assert.equal(evidence.compact_status, 'OVERFLOW');
            assert.equal(evidence.compact_refreshed, false);
            assert.ok(evidence.visible_summary_line.includes('compact=OVERFLOW'));
            assert.equal(evidence.visible_summary_line.includes('compact=REFRESHED_OVERFLOW_ACKNOWLEDGED'), false);
        });
    });

    it('does not acknowledge compact overflow when update evidence is missing', () => {
        withTempRepo((repoRoot) => {
            writeProjectMemoryWorkflowConfig(repoRoot);
            const taskId = 'T-115';
            const reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: ['src/gates/project-memory-impact.ts']
            }, null, 2), 'utf8');
            const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
            fs.writeFileSync(path.join(memoryRoot, 'compact.md'), 'x'.repeat(13000), 'utf8');

            const result = assessProjectMemoryImpact({ repoRoot, taskId, preflightPath });
            assert.equal(result.artifact.status, 'UPDATE_NEEDED');
            assert.equal(result.artifact.update_evidence.status, 'MISSING');
            fs.mkdirSync(path.dirname(result.artifactPath), { recursive: true });
            fs.writeFileSync(result.artifactPath, JSON.stringify(result.artifact, null, 2), 'utf8');

            const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId, preflightPath });
            assert.equal(evidence.evidence_status, 'CURRENT');
            assert.equal(evidence.status, 'UPDATE_NEEDED');
            assert.equal(evidence.compact_status, 'OVERFLOW');
            assert.equal(evidence.compact_refreshed, null);
            assert.ok(evidence.visible_summary_line.includes('compact=OVERFLOW'));
            assert.equal(evidence.visible_summary_line.includes('compact=REFRESHED_OVERFLOW_ACKNOWLEDGED'), false);
        });
    });

    it('reports malformed lifecycle impact artifacts as INVALID instead of throwing', () => {
        withTempRepo((repoRoot) => {
            writeProjectMemoryWorkflowConfig(repoRoot);
            const taskId = 'T-108';
            const reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ changed_files: [] }), 'utf8');
            const runtimeMemoryDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'project-memory');
            fs.mkdirSync(runtimeMemoryDir, { recursive: true });
            fs.writeFileSync(path.join(runtimeMemoryDir, `${taskId}-impact.json`), JSON.stringify({ schema_version: 1 }), 'utf8');

            const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId, preflightPath });

            assert.equal(evidence.evidence_status, 'INVALID');
            assert.ok(evidence.violations.some((violation) => violation.includes("field 'update_evidence'")));
            assert.ok(evidence.visible_summary_line.includes('evidence=INVALID'));
        });
    });

    it('fails closed on case-mismatched project memory workflow config keys', () => {
        withTempRepo((repoRoot) => {
            writeRawWorkflowConfig(repoRoot, {
                Project_Memory_Maintenance: {
                    enabled: true,
                    mode: 'check'
                }
            });

            assert.throws(
                () => getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId: 'T-109', preflightPath: null }),
                /must use the exact key 'project_memory_maintenance'/
            );
        });
    });

    it('keeps project memory config isolated from unrelated invalid workflow sections', () => {
        withTempRepo((repoRoot) => {
            writeRawWorkflowConfig(repoRoot, {
                project_memory_maintenance: {
                    enabled: true,
                    mode: 'check',
                    run_before_final_closeout: true
                },
                scope_budget_guard: {
                    enabled: true,
                    action: 'BLOCK_SOMEHOW'
                }
            });

            const evidence = getProjectMemoryImpactLifecycleEvidence({
                repoRoot,
                taskId: 'T-110',
                preflightPath: null
            });

            assert.equal(evidence.required, true);
            assert.notEqual(evidence.evidence_status, 'NOT_REQUIRED');
        });
    });
});
