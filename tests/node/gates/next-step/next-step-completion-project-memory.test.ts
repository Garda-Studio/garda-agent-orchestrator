import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { initGitRepo } from '../git-fixtures';
import {
    assessProjectMemoryImpact,
    getProjectMemoryImpactLifecycleEvidence,
    formatNextStepText,
    getWorkspaceSnapshot,
    resolveNextStep
} from './next-step-test-support';
import {
    buildProjectMemoryNextStepSummary
} from '../../../../src/gates/next-step/next-step-doc-closeout-readiness';
import {
    buildProjectMemoryImpactCommand
} from '../../../../src/gates/next-step/next-step-command-formatters';
import {
    TASK_ID,
    ALL_REVIEW_FLAGS,
    makeTempRepo,
    reviewsRoot,
    writeJson,
    writeProjectMemoryWorkflowConfig,
    seedProjectMemory,
    seedProjectMemoryImpact,
    fileSha256,
    appendEvent,
    seedStartedTask as seedBaseStartedTask,
    writeStrictDecompositionDecision,
    writePreflight,
    seedCompilePass,
    seedReviewGatePass,
    seedDocImpactPass} from './next-step-completion-fixtures';

const PROJECT_MEMORY_ORDER_VIOLATION =
    'Project memory impact evidence must be recorded after doc-impact-gate for the current completion cycle.';
const nodeRequire = createRequire(__filename);

function seedStartedTask(repoRoot: string, taskId: string): void {
    seedBaseStartedTask(repoRoot, taskId);
    writeStrictDecompositionDecision(repoRoot, taskId, {
        decision: 'single-cycle',
        taskProfile: 'balanced',
        expectedReviewTypes: ['none']
    });
}

function formatProjectMemorySummaryForTest(
    projectMemory: ReturnType<typeof buildProjectMemoryNextStepSummary>
): string {
    return formatNextStepText({
        schema_version: 1,
        task_id: TASK_ID,
        generated_utc: '2026-06-08T00:00:00.000Z',
        navigator_command: `node bin/garda.js next-step "${TASK_ID}" --repo-root "."`,
        status: 'BLOCKED',
        next_gate: 'project-memory-impact',
        title: 'Project memory formatter test.',
        reason: 'Project memory formatter test.',
        commands: [],
        missing_artifacts: [],
        present_artifacts: [],
        full_suite_validation: {
            enabled: true,
            placement: 'after_compile_before_reviews',
            command: 'npm test',
            config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
            timeout_forecast_note: null
        },
        project_memory: projectMemory,
        review: {
            review_execution_policy_mode: 'strict_sequential',
            review_execution_policy_source: 'preflight',
            review_finding_policy_id: 'custom',
            review_finding_policy_source: 'test-fixture',
            review_finding_policy_actions: {
                critical: 'fix_now',
                high: 'fix_now',
                medium: 'create_follow_up',
                low: 'create_follow_up',
                residual_risk: 'create_follow_up'
            },
            required_reviews: [],
            launchable_review_types: [],
            blocked_review_lanes: [],
            failed_review_type: null,
            ordinary_doc_review_skips: [],
            next_review_type: null,
            blocked_review_dependencies: [],
            trust_note: null
        },
        task_queue_status_contract: {
            visible_summary_line: 'Task status sync: formatter test.'
        },
        audit_status: 'BLOCKED',
        profile: null,
        markdown_working_plan: null,
        optional_skill_selection: null,
        warnings: [],
        invalidation_impact: null,
        review_cycle_block: null,
        final_report: null
    } as unknown as ReturnType<typeof resolveNextStep>);
}

describe('gates/next-step', () => {
    it('routes to project-memory-impact before completion when project memory maintenance is enabled', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'check' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'project-memory-impact');

        assert.equal(result.project_memory?.required, true);

        assert.equal(result.project_memory?.evidence_status, 'MISSING');

        assert.ok(result.commands[0].command.includes('gate project-memory-impact'));

        assert.ok(result.commands[0].command.includes('--preflight-path'));

        assert.ok(!result.commands[0].command.includes('gate completion-gate'));

    });



    it('continues to completion after current project-memory-impact evidence exists', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'check' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedProjectMemoryImpact(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'completion-gate', result.reason);

        assert.equal(result.project_memory?.evidence_status, 'CURRENT');

        assert.equal(result.project_memory?.status, 'NO_UPDATE_NEEDED');

        assert.ok(result.commands[0].command.includes('gate completion-gate'));

    });

    it('reuses the outer task timeline snapshot for closeout readiness', () => {
        const repoRoot = makeTempRepo();
        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'check' });
        seedProjectMemory(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedProjectMemoryImpact(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'PROJECT_MEMORY_IMPACT_ASSESSED');

        const timelinePath = path.resolve(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'task-events',
            `${TASK_ID}.jsonl`
        );
        const mutableFs = nodeRequire('node:fs') as typeof fs;
        const originalOpenSync = mutableFs.openSync;
        const originalReadFileSync = mutableFs.readFileSync;
        let closeoutTimelinePhysicalReads = 0;
        mutableFs.openSync = ((
            file: fs.PathLike,
            flags: fs.OpenMode,
            mode?: fs.Mode
        ) => {
            if (
                path.resolve(String(file)) === timelinePath
                && String(new Error().stack || '').includes('next-step-doc-closeout-readiness')
            ) {
                closeoutTimelinePhysicalReads += 1;
            }
            return originalOpenSync(file, flags, mode);
        }) as typeof fs.openSync;
        mutableFs.readFileSync = ((file: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
            if (
                typeof file === 'string'
                && path.resolve(file) === timelinePath
                && String(new Error().stack || '').includes('next-step-doc-closeout-readiness')
            ) {
                closeoutTimelinePhysicalReads += 1;
            }
            return originalReadFileSync(file as never, ...(args as never[]));
        }) as typeof fs.readFileSync;
        try {
            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, 'completion-gate', result.reason);
        } finally {
            mutableFs.openSync = originalOpenSync;
            mutableFs.readFileSync = originalReadFileSync;
        }

        assert.equal(closeoutTimelinePhysicalReads, 0);
    });

    it('recovers a stale project-memory order-only completion failure without refreshing unchanged preflight or review evidence', () => {
        const repoRoot = makeTempRepo();
        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'check' });
        seedProjectMemory(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedProjectMemoryImpact(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'PROJECT_MEMORY_IMPACT_ASSESSED');
        seedDocImpactPass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', {
            violations: [PROJECT_MEMORY_ORDER_VIOLATION]
        });

        const recovery = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(recovery.next_gate, 'project-memory-impact', recovery.reason);
        assert.doesNotMatch(recovery.commands[0].command, /classify-change/);

        seedProjectMemoryImpact(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'PROJECT_MEMORY_IMPACT_ASSESSED');

        const resumed = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(resumed.next_gate, 'completion-gate', resumed.reason);
    });

    it('rejects stale doc-impact binding before order-only recovery and fails closed', () => {
        const repoRoot = makeTempRepo();
        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'check' });
        seedProjectMemory(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedProjectMemoryImpact(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'PROJECT_MEMORY_IMPACT_ASSESSED');
        seedDocImpactPass(repoRoot, TASK_ID);

        const docImpactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`);
        const staleDocImpact = {
            ...JSON.parse(fs.readFileSync(docImpactPath, 'utf8')) as Record<string, unknown>,
            preflight_hash_sha256: '0'.repeat(64)
        };
        writeJson(docImpactPath, staleDocImpact);
        appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', staleDocImpact);
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', {
            violations: [PROJECT_MEMORY_ORDER_VIOLATION]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'project-memory-impact', result.reason);
        assert.match(result.commands[0]?.command || '', /classify-change|restart-review-cycle/);
    });

    it('labels accepted updated project-memory overflow as advisory when compact was not refreshed', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'update' });

        seedProjectMemory(repoRoot);

        const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');

        fs.writeFileSync(path.join(memoryRoot, 'compact.md'), 'x'.repeat(13000), 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        initGitRepo(repoRoot);

        const changedFiles = ['src/gates/project-memory-impact.ts'];

        const impactedSourcePath = path.join(repoRoot, changedFiles[0]);

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles });

        seedCompilePass(repoRoot, TASK_ID, undefined, changedFiles);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);

        const impact = assessProjectMemoryImpact({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            confirmUpdated: true,
            updatedMemoryFiles: [
                'garda-agent-orchestrator/live/docs/project-memory/commands.md',
                'garda-agent-orchestrator/live/docs/project-memory/compact.md',
                'garda-agent-orchestrator/live/docs/project-memory/decisions.md',
                'garda-agent-orchestrator/live/docs/project-memory/risks.md'
            ]
        });

        assert.ok(impact.updateEvidenceToWrite);

        writeJson(impact.updateArtifactPath, impact.updateEvidenceToWrite);

        writeJson(impact.artifactPath, impact.artifact);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'completion-gate', result.reason);

        assert.equal(result.project_memory?.evidence_status, 'CURRENT');

        assert.equal(result.project_memory?.status, 'UPDATED');

        assert.equal(result.project_memory?.compact_status, 'UPDATED_OVERFLOW_NOT_REFRESHED');

        assert.equal(result.project_memory?.compact_refreshed, false);

        assert.ok(result.project_memory?.visible_summary_line.includes('compact=UPDATED_OVERFLOW_NOT_REFRESHED'));

        assert.ok(result.project_memory?.visible_summary_line.includes('compact_refreshed=not_refreshed_update_accepted'));

        assert.equal(result.project_memory?.visible_summary_line.includes('compact=OVERFLOW; compact_refreshed=false'), false);

        assert.ok(result.known_non_blocking_signals.some((signal) => (
            signal.id === 'project_memory_updated_compact_overflow_accepted'
            && signal.action_required === false
        )));

        assert.ok(formatNextStepText(result).includes('compact=UPDATED_OVERFLOW_NOT_REFRESHED'));

        assert.ok(formatNextStepText(result).includes('Known non-blocking notes: Project memory compact overflow is accepted because current update evidence is valid'));

        assert.equal(formatNextStepText(result).includes('KnownNonBlockingSignals:'), false);

    });



    it('prints a project-memory confirmation command when missing evidence already has known affected files', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'update' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        initGitRepo(repoRoot);

        const changedFiles = ['src/gates/project-memory-impact.ts'];

        const impactedSourcePath = path.join(repoRoot, changedFiles[0]);

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles });

        seedCompilePass(repoRoot, TASK_ID, undefined, changedFiles);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'project-memory-impact');

        assert.equal(result.project_memory?.evidence_status, 'MISSING');

        assert.equal(result.project_memory?.update_needed, true);

        assert.match(result.commands[0].command, /--mode "update"/);

        assert.match(result.commands[0].command, /--confirm-updated/);

        assert.doesNotMatch(result.commands[0].command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);

        assert.match(result.commands[0].command, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);

        assert.match(result.commands[0].command, /--skip-unchanged-candidates-rationale /);

        const formatted = formatNextStepText(result);

        assert.match(formatted, /ProjectMemoryCommandSkippedFiles: .*garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md/);

    });

    it('prints changed project-memory candidates as updated files in the confirmation command', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'update' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        const changedFiles = ['src/cli/commands/project-memory-routing.ts'];

        const impactedSourcePath = path.join(repoRoot, changedFiles[0]);

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles });

        initGitRepo(repoRoot);

        const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');

        fs.appendFileSync(path.join(memoryRoot, 'compact.md'), '\nCurrent command-builder behavior: changed compact evidence.\n', 'utf8');

        fs.appendFileSync(path.join(memoryRoot, 'module-map.md'), '\nCurrent command-builder behavior: changed module map evidence.\n', 'utf8');

        const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId: TASK_ID, preflightPath });

        const summary = buildProjectMemoryNextStepSummary(repoRoot, evidence);

        const command = buildProjectMemoryImpactCommand(
            'node bin/garda.js',
            TASK_ID,
            'garda-agent-orchestrator/runtime/reviews/T-001-preflight.json',
            summary
        );

        assert.equal(summary.evidence_status, 'MISSING');

        assert.deepEqual(summary.command_updated_memory_files, [
            'garda-agent-orchestrator/live/docs/project-memory/compact.md',
            'garda-agent-orchestrator/live/docs/project-memory/module-map.md'
        ]);

        assert.match(command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/compact\.md"/);

        assert.match(command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/module-map\.md"/);

        assert.doesNotMatch(command, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/compact\.md"/);

        assert.doesNotMatch(command, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/module-map\.md"/);

        assert.match(command, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);

        const formatted = formatProjectMemorySummaryForTest(summary);

        assert.match(formatted, /ProjectMemoryCommandUpdatedFiles: .*garda-agent-orchestrator\/live\/docs\/project-memory\/compact\.md/);

        assert.match(formatted, /ProjectMemoryCommandUpdatedFiles: .*garda-agent-orchestrator\/live\/docs\/project-memory\/module-map\.md/);

        assert.match(formatted, /ProjectMemoryCommandSkippedFiles: .*garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md/);

    });

    it('treats directly scoped ignored project-memory files as updated command inputs instead of skipped candidates', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'update' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        const changedFiles = [
            'src/gates/project-memory-impact.ts',
            'garda-agent-orchestrator/live/docs/project-memory/commands.md'
        ];

        const impactedSourcePath = path.join(repoRoot, 'src', 'gates', 'project-memory-impact.ts');

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        const memoryCommandsPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'commands.md');

        fs.appendFileSync(memoryCommandsPath, '\nIgnored-scope command guidance changed.\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles });

        const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId: TASK_ID, preflightPath });

        const summary = buildProjectMemoryNextStepSummary(repoRoot, evidence, { taskId: TASK_ID, preflightPath });

        const command = buildProjectMemoryImpactCommand(
            'node bin/garda.js',
            TASK_ID,
            'garda-agent-orchestrator/runtime/reviews/T-001-preflight.json',
            summary
        );

        const formatted = formatProjectMemorySummaryForTest(summary);

        assert.deepEqual(summary.command_updated_memory_files, [
            'garda-agent-orchestrator/live/docs/project-memory/commands.md'
        ]);

        assert.match(command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);

        assert.doesNotMatch(command, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);

        assert.match(command, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/compact\.md"/);

        assert.match(formatted, /ProjectMemoryCommandUpdatedFiles: .*garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md/);

        assert.match(formatted, /ProjectMemoryCommandSkippedFiles: .*garda-agent-orchestrator\/live\/docs\/project-memory\/compact\.md/);

    });

    it('canonicalizes unprefixed scoped project-memory files before building updated command inputs', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'update' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        const changedFiles = [
            'src/gates/project-memory-impact.ts',
            'live/docs/project-memory/commands.md'
        ];

        const impactedSourcePath = path.join(repoRoot, 'src', 'gates', 'project-memory-impact.ts');

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        const memoryCommandsPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'commands.md');

        fs.appendFileSync(memoryCommandsPath, '\nUnprefixed ignored-scope command guidance changed.\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles });

        const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId: TASK_ID, preflightPath });

        const summary = buildProjectMemoryNextStepSummary(repoRoot, evidence, { taskId: TASK_ID, preflightPath });

        const command = buildProjectMemoryImpactCommand(
            'node bin/garda.js',
            TASK_ID,
            'garda-agent-orchestrator/runtime/reviews/T-001-preflight.json',
            summary
        );

        assert.deepEqual(summary.command_updated_memory_files, [
            'garda-agent-orchestrator/live/docs/project-memory/commands.md'
        ]);

        assert.match(command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);

        assert.doesNotMatch(command, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);

    });

    it('does not reuse stale lifecycle updates when the freshly assessed memory artifact is blocked', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'update' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        const changedFiles = ['src/gates/project-memory-impact.ts'];

        const impactedSourcePath = path.join(repoRoot, changedFiles[0]);

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles });

        const initialImpact = assessProjectMemoryImpact({ repoRoot, taskId: TASK_ID, preflightPath });

        writeJson(initialImpact.artifactPath, initialImpact.artifact);

        const confirmedImpact = assessProjectMemoryImpact({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            confirmUpdated: true,
            updatedMemoryFiles: initialImpact.artifact.affected_memory_files
        });

        assert.ok(confirmedImpact.updateEvidenceToWrite);

        writeJson(confirmedImpact.updateArtifactPath, confirmedImpact.updateEvidenceToWrite);

        writeJson(confirmedImpact.artifactPath, confirmedImpact.artifact);

        const lifecycleEvidence = getProjectMemoryImpactLifecycleEvidence({
            repoRoot,
            taskId: TASK_ID,
            preflightPath
        });

        assert.equal(lifecycleEvidence.evidence_status, 'CURRENT');

        assert.equal(lifecycleEvidence.status, 'UPDATED');

        const updatedMemoryPath = path.join(repoRoot, initialImpact.artifact.affected_memory_files[0]);

        fs.appendFileSync(updatedMemoryPath, '\nChanged after lifecycle evidence was read.\n', 'utf8');
        fs.renameSync(path.join(repoRoot, '.git'), path.join(repoRoot, '.git-unavailable'));

        const summary = buildProjectMemoryNextStepSummary(
            repoRoot,
            lifecycleEvidence,
            { taskId: TASK_ID, preflightPath }
        );

        assert.deepEqual(summary.command_updated_memory_files, []);

        assert.deepEqual(summary.command_skipped_memory_files, initialImpact.artifact.affected_memory_files);

        assert.ok(summary.command_update_inference_error);

    });

    it('does not print an accepting project-memory confirmation command when update inference fails', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'update' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        const changedFiles = ['src/cli/commands/project-memory-routing.ts'];

        const impactedSourcePath = path.join(repoRoot, changedFiles[0]);

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles });

        const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId: TASK_ID, preflightPath });
        fs.renameSync(path.join(repoRoot, '.git'), path.join(repoRoot, '.git-unavailable'));

        const summary = buildProjectMemoryNextStepSummary(repoRoot, evidence);

        const command = buildProjectMemoryImpactCommand(
            'node bin/garda.js',
            TASK_ID,
            'garda-agent-orchestrator/runtime/reviews/T-001-preflight.json',
            summary
        );

        assert.equal(summary.evidence_status, 'MISSING');

        assert.ok(summary.command_update_inference_error);

        assert.doesNotMatch(command, /--confirm-updated/);

        assert.doesNotMatch(command, /--skipped-memory-file/);

        assert.match(command, /gate project-memory-impact/);

        const formatted = formatProjectMemorySummaryForTest(summary);

        assert.match(formatted, /ProjectMemoryCommandUpdateInference: /);

        assert.doesNotMatch(formatted, /ProjectMemoryCommandSkippedFiles:/);

    });

    it('does not reuse blocked project-memory evidence files as updated command inputs', () => {

        const repoRoot = makeTempRepo();

        const summary = buildProjectMemoryNextStepSummary(repoRoot, {
            enabled: true,
            required: true,
            mode: 'update',
            evidence_status: 'BLOCKED',
            status: 'BLOCKED',
            outcome: 'FAIL',
            update_needed: true,
            affected_memory_files: [
                'garda-agent-orchestrator/live/docs/project-memory/compact.md'
            ],
            updated_memory_files: [
                'garda-agent-orchestrator/live/docs/project-memory/compact.md'
            ],
            compact_status: 'OVERFLOW',
            compact_refreshed: false,
            artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-001-project-memory-impact.json',
            update_artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-001-project-memory-update.json',
            visible_summary_line: 'Project memory: enabled; mode=update; evidence=BLOCKED',
            violations: ['Synthetic blocked evidence for formatter regression.']
        } as ReturnType<typeof getProjectMemoryImpactLifecycleEvidence>);

        const command = buildProjectMemoryImpactCommand(
            'node bin/garda.js',
            TASK_ID,
            'garda-agent-orchestrator/runtime/reviews/T-001-preflight.json',
            summary
        );

        const formatted = formatProjectMemorySummaryForTest(summary);

        assert.equal(summary.command_updated_memory_files.length, 0);

        assert.ok(summary.command_update_inference_error);

        assert.doesNotMatch(command, /--confirm-updated/);

        assert.doesNotMatch(command, /--updated-memory-file/);

        assert.match(formatted, /ProjectMemoryCommandUpdateInference: /);

        assert.doesNotMatch(formatted, /ProjectMemoryCommandSkippedFiles:/);

    });

    it('does not print an accepting command when project-memory diff includes non-candidate files', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'update' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        const changedFiles = ['src/cli/commands/project-memory-routing.ts'];

        const impactedSourcePath = path.join(repoRoot, changedFiles[0]);

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles });

        initGitRepo(repoRoot);

        const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');

        fs.appendFileSync(path.join(memoryRoot, 'compact.md'), '\nCurrent command-builder behavior: changed compact evidence.\n', 'utf8');

        fs.appendFileSync(path.join(memoryRoot, 'risks.md'), '\nCurrent command-builder behavior: changed non-candidate risk evidence.\n', 'utf8');

        const evidence = getProjectMemoryImpactLifecycleEvidence({ repoRoot, taskId: TASK_ID, preflightPath });

        const summary = buildProjectMemoryNextStepSummary(repoRoot, evidence);

        const command = buildProjectMemoryImpactCommand(
            'node bin/garda.js',
            TASK_ID,
            'garda-agent-orchestrator/runtime/reviews/T-001-preflight.json',
            summary
        );

        const formatted = formatProjectMemorySummaryForTest(summary);

        assert.equal(summary.evidence_status, 'MISSING');

        assert.ok(summary.command_update_inference_error);

        assert.match(summary.command_update_inference_error, /non-candidate files/);

        assert.doesNotMatch(command, /--confirm-updated/);

        assert.doesNotMatch(command, /--updated-memory-file/);

        assert.doesNotMatch(command, /--skipped-memory-file/);

        assert.match(formatted, /ProjectMemoryCommandUpdateInference: .*non-candidate files/);

    });

    it('routes to project-memory-impact before doc-impact when internal-only doc-impact would claim project-memory-updated', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'update' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        initGitRepo(repoRoot);

        const changedFiles = ['src/gates/project-memory-impact.ts'];

        const impactedSourcePath = path.join(repoRoot, changedFiles[0]);

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles });

        seedCompilePass(repoRoot, TASK_ID, undefined, changedFiles);

        seedReviewGatePass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'project-memory-impact', result.reason);

        assert.equal(result.project_memory?.evidence_status, 'MISSING');

        assert.match(result.commands[0].command, /gate project-memory-impact/);

        assert.doesNotMatch(result.commands[0].command, /gate doc-impact-gate/);

    });



    it('prints a ready-to-run project-memory confirmation command when current evidence is blocked', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'strict' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        initGitRepo(repoRoot);

        const impactedSourcePath = path.join(repoRoot, 'src', 'gates', 'project-memory-impact.ts');

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        const preflightPath = writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS },
            { changedFiles: ['src/gates/project-memory-impact.ts'] }
        );

        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/gates/project-memory-impact.ts']);

        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`), {

            timestamp_utc: new Date().toISOString(),

            task_id: TASK_ID,

            event_source: 'compile-gate',

            status: 'PASSED',

            outcome: 'PASS',

            preflight_path: preflightPath.replace(/\\/g, '/'),

            preflight_hash_sha256: fileSha256(preflightPath),

            scope_detection_source: snapshot.detection_source,

            scope_include_untracked: snapshot.include_untracked,

            scope_changed_files: snapshot.changed_files,

            scope_changed_files_count: snapshot.changed_files_count,

            scope_changed_lines_total: snapshot.changed_lines_total,

            scope_changed_files_sha256: snapshot.changed_files_sha256,

            scope_content_sha256: snapshot.scope_content_sha256,

            scope_sha256: snapshot.scope_sha256

        });

        appendEvent(repoRoot, TASK_ID, 'COMPILE_GATE_PASSED', 'PASS');

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        const impact = assessProjectMemoryImpact({ repoRoot, taskId: TASK_ID, preflightPath });

        writeJson(impact.artifactPath, impact.artifact);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'project-memory-impact');

        assert.equal(result.project_memory?.evidence_status, 'BLOCKED');

        assert.match(result.commands[0].command, /--mode "strict"/);

        assert.match(result.commands[0].command, /--preflight-path /);

        assert.match(result.commands[0].command, /--confirm-updated/);

        assert.doesNotMatch(result.commands[0].command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);

        assert.match(result.commands[0].command, /--skipped-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);

        assert.match(result.commands[0].command, /--skip-unchanged-candidates-rationale /);

    });



});
