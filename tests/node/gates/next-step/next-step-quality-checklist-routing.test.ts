import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION,
    isOptionalQualityCheckRuleActiveForScope
} from '../../../../src/core/workflow-config';
import {
    buildDefaultWorkflowConfig,
    resolveNextStep,
    type FullSuiteValidationConfig
} from './next-step-test-support';
import {
    ALL_REVIEW_FLAGS,
    TASK_ID,
    appendEvent,
    fileSha256,
    makeTempRepo,
    normalizeForTimeline,
    reviewsRoot,
    seedCompilePass,
    seedStartedTask as seedBaseStartedTask,
    writeStrictDecompositionDecision,
    writeJson,
    writePreflight
} from './next-step-full-suite-fixtures';
import {
    runQualityChecklistCommand
} from '../../../../src/cli/commands/gate-flows/quality-checklist/quality-checklist-flow';
import {
    readQualityChecklistReadiness
} from '../../../../src/gates/next-step/next-step-quality-checklist-readiness';
import {
    createNextStepEffectExecutor,
    createNextStepEffectPlanner
} from '../../../../src/gates/next-step/next-step-effects';
import {
    initializeGitRepo,
    runGit
} from '../../cli/commands/gate-test-repo-bootstrap';

type QualityChecklistStatus = 'PASS' | 'WARN' | 'ACTION_REQUIRED' | 'SKIPPED_DISABLED' | 'SKIPPED_CADENCE' | 'CONFIG_ERROR';
type WorkflowConfig = ReturnType<typeof buildDefaultWorkflowConfig>;

const T839_DERIVED_QUALITY_ACTIONS = Object.freeze([
    'Add tests/** regression files to the current preflight and review scope.',
    'Cover classifier wording, separator variants, standalone forms, and OAuth2-style suffixes.',
    'Validate trust artifact identity persistence, stale rejection, forged rejection, and legacy fallback.',
    'Synchronize doc-impact next-step commands, direct gate validation, and CLI evidence parity.',
    'Cover task queue parser child id forms, missing child rows, mixed statuses, and RegExp reentrancy.',
    'Ignore pending or stale review-cycle telemetry and extract bloated guard helpers before review.',
    'Require current audited no-op evidence before full-suite, review-context, or reviewer-launch routing.'
]);

const MOVED_PROJECT_LOCAL_RULE_IDS = Object.freeze([
    'classifier_intent_edge_cases',
    'config_materialization_parity',
    'control_plane_action_safety',
    'artifact_evidence_binding',
    'gate_routing_self_regression'
]);

const CUSTOM_GARDA_RULE_IDS = Object.freeze([
    'custom_garda_classifier_intent_edge_cases',
    'custom_garda_config_materialization_parity',
    'custom_garda_control_plane_action_safety',
    'custom_garda_artifact_evidence_binding',
    'custom_garda_gate_routing_self_regression'
]);

function workflowConfigPath(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
}

function currentQualityChecklistReadinessOptions(repoRoot: string) {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
    return {
        repoRoot,
        reviewsRoot: reviewsRoot(repoRoot),
        taskId: TASK_ID,
        preflight: JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
        preflightPath,
        preflightSha256: fileSha256(preflightPath),
        workflowConfig: JSON.parse(
            fs.readFileSync(workflowConfigPath(repoRoot), 'utf8')
        ) as Record<string, unknown>
    };
}

function readCurrentQualityChecklistReadiness(
    repoRoot: string
): ReturnType<typeof readQualityChecklistReadiness> {
    const options = currentQualityChecklistReadinessOptions(repoRoot);
    const planner = createNextStepEffectPlanner();
    const preview = readQualityChecklistReadiness({ ...options, effects: planner });
    const plan = planner.pendingPlan();
    if (!plan) {
        return preview;
    }
    return readQualityChecklistReadiness({
        ...options,
        effects: createNextStepEffectExecutor(plan)
    });
}

function qualityChecklistAnswersPath(repoRoot: string, taskId = TASK_ID): string {
    return path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'tmp',
        `${taskId}-quality-checklist-answers.json`
    );
}

function qualityChecklistRepairAnswersPath(repoRoot: string, taskId = TASK_ID): string {
    return `${qualityChecklistAnswersPath(repoRoot, taskId)}.repair.json`;
}

function qualityChecklistRecoveryAnswersPath(repoRoot: string, taskId = TASK_ID): string {
    return `${qualityChecklistRepairAnswersPath(repoRoot, taskId)}.recovery.json`;
}

function qualityChecklistAnswersCommandPath(taskId = TASK_ID): string {
    return `garda-agent-orchestrator/runtime/tmp/${taskId}-quality-checklist-answers.json`;
}

function completeChecklistAnswersWithInvalidFirstStatus(repoRoot: string): number {
    const answersPath = qualityChecklistAnswersPath(repoRoot);
    const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
        answers: Array<Record<string, unknown>>;
    };
    template.answers = template.answers.map((answer, index) => ({
        ...answer,
        status: index === 0 ? 'INVALID' : 'PASS',
        answer: `Completed answer for ${String(answer.rule_id)}.`
    }));
    fs.writeFileSync(answersPath, JSON.stringify(template, null, 2) + '\n', 'utf8');
    return template.answers.length;
}

function qualityChecklistRepairAnswersCommandPath(taskId = TASK_ID): string {
    return `${qualityChecklistAnswersCommandPath(taskId)}.repair.json`;
}

function qualityChecklistRotatedRecoveryAnswersPath(repoRoot: string, taskId = TASK_ID): string {
    return `${qualityChecklistRepairAnswersPath(repoRoot, taskId)}.recovery.2.json`;
}

function writeWorkspaceChange(repoRoot: string, relativePath: string): void {
    const absolutePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `Synthetic workspace change for ${relativePath}.\n`, 'utf8');
}

function seedStartedTask(repoRoot: string, taskId: string): void {
    seedBaseStartedTask(repoRoot, taskId);
    writeStrictDecompositionDecision(repoRoot, taskId);
}

function initializeWorkspaceBaseline(repoRoot: string, additionalPaths: readonly string[]): void {
    fs.writeFileSync(
        path.join(repoRoot, '.gitignore'),
        'garda-agent-orchestrator/runtime/\n',
        'utf8'
    );
    for (const relativePath of additionalPaths) {
        const absolutePath = path.join(repoRoot, relativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, `Baseline for ${relativePath}.\n`, 'utf8');
    }
    initializeGitRepo(repoRoot);
}

function restoreWorkspaceChanges(repoRoot: string, ...relativePaths: string[]): void {
    runGit(repoRoot, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...relativePaths]);
}

function normalizeTestPath(pathValue: string | null | undefined): string | null {
    return pathValue ? pathValue.replace(/\\/g, '/') : null;
}

function buildTestQualityRule(id: string): ReturnType<typeof buildDefaultWorkflowConfig>['optional_quality_checks']['rules'][number] {
    return {
        id,
        title: `Rule ${id}`,
        prompt: `Check ${id}.`,
        enabled: true
    };
}

function buildQualityChecklistRuleSnapshot(options: {
    rules?: WorkflowConfig['optional_quality_checks']['rules'];
    titlePrefix?: string;
    promptPrefix?: string;
    scopeCategory?: string;
    changedFiles?: readonly string[];
} = {}): Array<Record<string, unknown>> {
    const rules = options.rules ?? buildDefaultWorkflowConfig().optional_quality_checks.rules;
    const scopeCategory = options.scopeCategory ?? 'mixed';
    const changedFiles = options.changedFiles ?? ['src/app.ts'];
    return rules.map((rule) => ({
        id: rule.id,
        title: `${options.titlePrefix ?? ''}${rule.title}`,
        prompt: `${options.promptPrefix ?? ''}${rule.prompt}`,
        enabled: rule.enabled,
        included_scope_categories: rule.included_scope_categories ?? [],
        included_changed_file_regexes: rule.included_changed_file_regexes ?? [],
        excluded_scope_categories: rule.excluded_scope_categories ?? [],
        scope_applicability: rule.enabled === false
            ? 'disabled'
            : isOptionalQualityCheckRuleActiveForScope(rule, scopeCategory, changedFiles)
                ? 'active'
                : 'skipped_by_scope'
    }));
}

function buildQualityChecklistAnswers(options: {
    rules?: WorkflowConfig['optional_quality_checks']['rules'];
    omitRuleIds?: readonly string[];
    scopeCategory?: string;
    changedFiles?: readonly string[];
} = {}): Array<Record<string, unknown>> {
    const omitted = new Set(options.omitRuleIds ?? []);
    const rules = options.rules ?? buildDefaultWorkflowConfig().optional_quality_checks.rules;
    const scopeCategory = options.scopeCategory ?? 'mixed';
    const changedFiles = options.changedFiles ?? ['src/app.ts'];
    return rules
        .filter((rule) => (
            isOptionalQualityCheckRuleActiveForScope(rule, scopeCategory, changedFiles) && !omitted.has(rule.id)
        ))
        .map((rule) => ({
            rule_id: rule.id,
            status: 'PASS',
            answer: `Rule ${rule.id} passed.`
        }));
}

function writeWorkflowConfig(repoRoot: string, options: {
    optionalQualityChecksEnabled?: boolean;
    fullSuiteEnabled?: boolean;
    fullSuitePlacement?: FullSuiteValidationConfig['placement'];
    configure?: (config: WorkflowConfig) => void;
} = {}): void {
    const config = buildDefaultWorkflowConfig();
    config.optional_quality_checks.enabled = options.optionalQualityChecksEnabled ?? true;
    config.full_suite_validation.enabled = options.fullSuiteEnabled ?? false;
    config.full_suite_validation.command = 'npm test';
    if (options.fullSuitePlacement) {
        config.full_suite_validation.placement = options.fullSuitePlacement;
    }
    config.review_execution_policy = { mode: 'parallel_all' };
    config.project_memory_maintenance.enabled = false;
    config.project_memory_maintenance.mode = 'check';
    options.configure?.(config);
    writeJson(workflowConfigPath(repoRoot), config);
}

function writeStaleMovedRuleWorkflowConfig(repoRoot: string): void {
    const config = buildDefaultWorkflowConfig();
    config.optional_quality_checks.enabled = true;
    config.optional_quality_checks.baseline_version = '2026-06-26.t843';
    config.optional_quality_checks.rules = [
        ...config.optional_quality_checks.rules,
        ...MOVED_PROJECT_LOCAL_RULE_IDS.map(buildTestQualityRule),
        ...CUSTOM_GARDA_RULE_IDS.map(buildTestQualityRule)
    ];
    config.full_suite_validation.enabled = false;
    config.review_execution_policy = { mode: 'parallel_all' };
    config.project_memory_maintenance.enabled = false;
    config.project_memory_maintenance.mode = 'check';
    writeJson(workflowConfigPath(repoRoot), config);
}

function writeQualityChecklistArtifact(
    repoRoot: string,
    taskId: string,
    status: QualityChecklistStatus,
    options: {
        preflightSha256?: string | null;
        workflowConfigSha256?: string | null;
        actionsTaken?: string[];
        actionsRequired?: string[];
        scopeCategory?: string;
        rules?: Array<Record<string, unknown>>;
        answers?: Array<Record<string, unknown>>;
    } = {}
): void {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const actionsRequired = status === 'ACTION_REQUIRED'
        ? options.actionsRequired ?? ['Simplify the routing helper before continuing.']
        : [];
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-quality-checklist.json`), {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'quality-checklist',
        task_id: taskId,
        checklist_id: 'optional_quality_checks',
        status,
        outcome: status === 'PASS'
            ? 'PASS'
            : status === 'WARN'
                ? 'WARN'
                : status === 'SKIPPED_DISABLED' || status === 'SKIPPED_CADENCE'
                    ? 'INFO'
                    : 'FAIL',
        workflow_config_path: normalizeForTimeline(workflowConfigPath(repoRoot)),
        workflow_config_sha256: options.workflowConfigSha256 === undefined
            ? fileSha256(workflowConfigPath(repoRoot))
            : options.workflowConfigSha256,
        preflight_path: normalizeForTimeline(preflightPath),
        preflight_sha256: options.preflightSha256 === undefined
            ? fileSha256(preflightPath)
            : options.preflightSha256,
        changed_file_evidence: {
            changed_files: ['src/app.ts'],
            changed_files_count: 1,
            changed_files_sha256: 'changed-files-sha',
            scope_sha256: 'scope-sha',
            scope_content_sha256: 'scope-content-sha',
            scope_category: options.scopeCategory ?? 'mixed'
        },
        scope_category: options.scopeCategory ?? 'mixed',
        rules: options.rules ?? [],
        answers: options.answers ?? [],
        actions_taken: options.actionsTaken ?? [],
        actions_required: actionsRequired,
        violations: []
    });
    appendEvent(repoRoot, taskId, 'QUALITY_CHECKLIST_RECORDED', status === 'PASS' ? 'PASS' : 'INFO', {
        status,
        artifact_path: normalizeForTimeline(path.join(reviewsRoot(repoRoot), `${taskId}-quality-checklist.json`))
    });
}

function appendReviewFailure(repoRoot: string, reviewType = 'code'): void {
    appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
        review_type: reviewType,
        verdict_token: `${reviewType.toUpperCase()} REVIEW FAILED`
    });
}

function appendCanonicalReviewFailure(repoRoot: string, reviewType = 'code'): void {
    const reviewArtifactPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'reviews',
        `${TASK_ID}-${reviewType}.md`
    );
    fs.mkdirSync(path.dirname(reviewArtifactPath), { recursive: true });
    fs.writeFileSync(reviewArtifactPath, '## Verdict\nREVIEW FAILED\n', 'utf8');
    appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
        review_type: reviewType,
        review_artifact_snapshot_path: reviewArtifactPath
    });
}

describe('gates/next-step quality checklist routing', () => {
    it('requires trust-boundary checklist evidence for protected planned scope before files are dirty', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS, code: true },
            { changedFiles: [] }
        );
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.triggers = { protected_control_plane_changed: true };
        writeJson(preflightPath, preflight);

        const readiness = readCurrentQualityChecklistReadiness(repoRoot);

        assert.equal(readiness.required, true);
        assert.equal(readiness.ready, false);
        assert.equal(readiness.evidenceStatus, 'missing');
        assert.ok(readiness.activeRuleCount > 0);
    });

    it('keeps direct quality-checklist readiness inspection side-effect free without an executor', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        const questionReferencePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            `${TASK_ID}-quality-checklist-questions.md`
        );

        const readiness = readQualityChecklistReadiness(
            currentQualityChecklistReadinessOptions(repoRoot)
        );

        assert.equal(readiness.evidenceStatus, 'missing');
        assert.equal(fs.existsSync(answersPath), false);
        assert.equal(fs.existsSync(`${answersPath}.binding.json`), false);
        assert.equal(fs.existsSync(questionReferencePath), false);
    });

    it('withholds the quality checklist command until the materialized answers are complete', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.quality_checklist?.evidence_status, 'missing');
        assert.equal(result.quality_checklist?.effect, 'missing');
        assert.match(result.quality_checklist?.visible_summary_line || '', /QualityChecklist: enabled=true; required=true/u);
        assert.match(result.quality_checklist?.visible_summary_line || '', /active_rules=7; skipped_by_scope=4/u);
        assert.equal(result.commands.length, 0);
        assert.equal(normalizeTestPath(result.quality_checklist?.answers_template_path), normalizeTestPath(qualityChecklistAnswersPath(repoRoot)));
        assert.match(result.reason, /Complete every active answer/u);
        assert.ok(result.reason.includes(qualityChecklistAnswersCommandPath()));
        assert.match(result.reason, /executable quality-checklist command is emitted only after the answers are valid/u);
        const questionReferencePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            `${TASK_ID}-quality-checklist-questions.md`
        );
        assert.match(result.reason, /Complete active-question reference:/u);
        const questionReference = fs.readFileSync(questionReferencePath, 'utf8');
        const activeRuleIds = buildDefaultWorkflowConfig().optional_quality_checks.rules
            .filter((rule) => rule.enabled && isOptionalQualityCheckRuleActiveForScope(rule, 'mixed', ['src/app.ts']))
            .map((rule) => rule.id);
        assert.ok(activeRuleIds.every((ruleId) => questionReference.includes(`- ${ruleId}:`)));
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
            answers: Array<Record<string, unknown>>;
        };
        assert.equal(template.answers.length, 7);
        assert.ok(template.answers.every((answer) => answer.status === '' && answer.answer === ''));
        template.answers = template.answers.map((answer) => ({
            ...answer,
            status: 'PASS',
            answer: `Rule ${String(answer.rule_id)} passed.`
        }));
        fs.writeFileSync(answersPath, JSON.stringify(template, null, 2) + '\n', 'utf8');

        const executable = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(executable.commands[0].label, 'Run quality checklist');
        assert.ok(executable.commands[0].command.includes('gate quality-checklist'));
        assert.ok(executable.commands[0].command.includes(`--answers-path "${qualityChecklistAnswersCommandPath()}"`));
        assert.equal(executable.commands[0].command.includes('--answers-json'), false);

        const checklistResult = runQualityChecklistCommand({
            repoRoot,
            taskId: TASK_ID,
            preflightPath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            answersPath,
            emitMetrics: false
        });
        assert.equal(checklistResult.exitCode, 0);
        assert.equal(resolveNextStep({ taskId: TASK_ID, repoRoot }).next_gate, 'compile-gate');
    });

    it('surfaces completed answer validation failures instead of reporting zero answers', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const initial = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(initial.next_gate, 'quality-checklist', initial.reason);
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
            answers: Array<Record<string, unknown>>;
        };
        template.answers = template.answers.map((answer, index) => ({
            ...answer,
            status: index === 0 ? 'INVALID' : 'PASS',
            answer: `Completed answer for ${String(answer.rule_id)}.`
        }));
        fs.writeFileSync(answersPath, JSON.stringify(template, null, 2) + '\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.commands.length, 0);
        assert.equal(result.quality_checklist?.evidence_status, 'invalid');
        assert.equal(result.quality_checklist?.status, 'CONFIG_ERROR');
        assert.equal(result.quality_checklist?.answer_count, template.answers.length - 1);
        assert.match(result.reason, /Completed quality checklist answers failed validation/u);
        assert.match(result.reason, /Missing answer for active quality-check rule 'code_simplification'/u);
        assert.match(result.reason, /Correct the answers template and rerun next-step/u);
    });

    it('surfaces replacement answer validation failures when prior checklist evidence is stale', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        resolveNextStep({ taskId: TASK_ID, repoRoot });
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
            answers: Array<Record<string, unknown>>;
        };
        template.answers = template.answers.map((answer) => ({
            ...answer,
            status: 'PASS',
            answer: `Initial answer for ${String(answer.rule_id)}.`
        }));
        fs.writeFileSync(answersPath, JSON.stringify(template, null, 2) + '\n', 'utf8');
        assert.equal(runQualityChecklistCommand({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            answersPath,
            emitMetrics: false
        }).exitCode, 0);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        refreshedPreflight.timestamp_utc = '2026-01-02T00:00:00.000Z';
        writeJson(preflightPath, refreshedPreflight);
        resolveNextStep({ taskId: TASK_ID, repoRoot });
        const answerCount = completeChecklistAnswersWithInvalidFirstStatus(repoRoot);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.commands.length, 0);
        assert.equal(result.quality_checklist?.evidence_status, 'invalid');
        assert.equal(result.quality_checklist?.status, 'CONFIG_ERROR');
        assert.equal(result.quality_checklist?.answer_count, answerCount - 1);
        assert.match(result.reason, /Completed quality checklist answers failed validation/u);
        assert.match(result.reason, /Missing answer for active quality-check rule 'code_simplification'/u);
    });

    it('keeps a current blank answers template in the manual completion route', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const first = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const second = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(first.next_gate, 'quality-checklist', first.reason);
        assert.equal(second.next_gate, 'quality-checklist', second.reason);
        assert.ok(fs.existsSync(qualityChecklistAnswersPath(repoRoot)));
        assert.equal(fs.existsSync(qualityChecklistRepairAnswersPath(repoRoot)), false);
        assert.equal(first.commands.length, 0);
        assert.equal(second.commands.length, 0);
        assert.match(second.reason, /Complete every active answer/u);
        assert.equal(normalizeTestPath(second.quality_checklist?.answers_template_path), normalizeTestPath(qualityChecklistAnswersPath(repoRoot)));
    });

    it('routes invalid JSON answers templates through a repair answers path without overwriting the unsafe original', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        fs.mkdirSync(path.dirname(answersPath), { recursive: true });
        fs.writeFileSync(answersPath, '{not valid json', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.commands.length, 0);
        assert.equal(normalizeTestPath(result.quality_checklist?.answers_template_path), normalizeTestPath(qualityChecklistRepairAnswersPath(repoRoot)));
        assert.match(result.reason, /Unsafe existing answers template preserved/u);
        assert.match(result.reason, /repair template materialized/u);
        assert.equal(fs.readFileSync(answersPath, 'utf8'), '{not valid json');
        const repairPath = qualityChecklistRepairAnswersPath(repoRoot);
        assert.ok(fs.existsSync(repairPath));
        const repairTemplate = JSON.parse(fs.readFileSync(repairPath, 'utf8')) as {
            answers: Array<Record<string, unknown>>;
        };
        repairTemplate.answers = repairTemplate.answers.map((answer) => ({
            ...answer,
            status: 'PASS',
            answer: `Preserved repair answer for ${String(answer.rule_id)}.`
        }));
        fs.writeFileSync(repairPath, JSON.stringify(repairTemplate, null, 2) + '\n', 'utf8');
        const filledRepairBytes = fs.readFileSync(repairPath, 'utf8');

        const repeated = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(repeated.commands.length, 1);
        assert.ok(repeated.commands[0].command.includes(`--answers-path "${qualityChecklistRepairAnswersCommandPath()}"`));
        assert.equal(fs.readFileSync(repairPath, 'utf8'), filledRepairBytes);
        const checklistResult = runQualityChecklistCommand({
            repoRoot,
            taskId: TASK_ID,
            preflightPath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            answersPath: repairPath,
            emitMetrics: false
        });
        assert.equal(checklistResult.exitCode, 0);
    });

    it('keeps routing to an authenticated repair path after answers are submitted as a bare array', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        fs.mkdirSync(path.dirname(answersPath), { recursive: true });
        fs.writeFileSync(answersPath, '{unsafe canonical json', 'utf8');

        resolveNextStep({ taskId: TASK_ID, repoRoot });
        const repairPath = qualityChecklistRepairAnswersPath(repoRoot);
        const repairTemplate = JSON.parse(fs.readFileSync(repairPath, 'utf8')) as {
            answers: Array<Record<string, unknown>>;
        };
        const submittedAnswers = repairTemplate.answers.map((answer) => ({
            ...answer,
            status: 'PASS',
            answer: `Submitted repair answer for ${String(answer.rule_id)}.`
        }));
        fs.writeFileSync(repairPath, JSON.stringify(submittedAnswers, null, 2) + '\n', 'utf8');

        const repeated = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(repeated.next_gate, 'quality-checklist', repeated.reason);
        assert.ok(repeated.commands[0].command.includes(`--answers-path "${qualityChecklistRepairAnswersCommandPath()}"`));
        assert.equal(fs.existsSync(qualityChecklistRecoveryAnswersPath(repoRoot)), false);
        const normalizedTemplate = JSON.parse(fs.readFileSync(repairPath, 'utf8')) as {
            event_source: string;
            answers: Array<Record<string, unknown>>;
        };
        assert.equal(normalizedTemplate.event_source, 'quality-checklist-answers-template');
        assert.ok(normalizedTemplate.answers.every((answer) => answer.status === 'PASS'));
    });

    it('rebinds filled repair answers after a coherent preflight refresh without an empty-template loop', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        initializeWorkspaceBaseline(repoRoot, ['src/coherent-restart.ts']);
        writeWorkspaceChange(repoRoot, 'src/app.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        fs.mkdirSync(path.dirname(answersPath), { recursive: true });
        fs.writeFileSync(answersPath, '{unsafe canonical json', 'utf8');

        resolveNextStep({ taskId: TASK_ID, repoRoot });
        const repairPath = qualityChecklistRepairAnswersPath(repoRoot);
        const repairTemplate = JSON.parse(fs.readFileSync(repairPath, 'utf8')) as {
            preflight_sha256: string;
            answers: Array<Record<string, unknown>>;
        };
        repairTemplate.answers = repairTemplate.answers.map((answer) => ({
            ...answer,
            status: 'PASS',
            answer: `Restart-safe repair answer for ${String(answer.rule_id)}.`
        }));
        fs.writeFileSync(repairPath, JSON.stringify(repairTemplate, null, 2) + '\n', 'utf8');
        writeWorkspaceChange(repoRoot, 'src/coherent-restart.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/app.ts', 'src/coherent-restart.ts']
        });

        const refreshed = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const reboundBytes = fs.readFileSync(repairPath, 'utf8');
        const reboundTemplate = JSON.parse(reboundBytes) as {
            preflight_sha256: string;
            answers: Array<Record<string, unknown>>;
        };
        const repeated = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(refreshed.next_gate, 'quality-checklist', refreshed.reason);
        assert.ok(refreshed.commands[0].command.includes(`--answers-path "${qualityChecklistRepairAnswersCommandPath()}"`));
        assert.notEqual(reboundTemplate.preflight_sha256, repairTemplate.preflight_sha256);
        assert.ok(reboundTemplate.answers.every((answer) => answer.status === 'PASS'));
        assert.ok(reboundTemplate.answers.every((answer) => String(answer.answer).startsWith('Restart-safe repair answer for ')));
        assert.equal(fs.readFileSync(repairPath, 'utf8'), reboundBytes);
        assert.ok(repeated.commands[0].command.includes(`--answers-path "${qualityChecklistRepairAnswersCommandPath()}"`));
    });

    it('preserves an invalid repair draft and routes repeated navigation to a separate recovery draft', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        fs.mkdirSync(path.dirname(answersPath), { recursive: true });
        fs.writeFileSync(answersPath, '{unsafe canonical json', 'utf8');
        resolveNextStep({ taskId: TASK_ID, repoRoot });
        const repairPath = qualityChecklistRepairAnswersPath(repoRoot);
        fs.writeFileSync(repairPath, '{invalid repair json', 'utf8');

        const recovered = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const recoveryPath = qualityChecklistRecoveryAnswersPath(repoRoot);
        const recoveryBytes = fs.readFileSync(recoveryPath, 'utf8');
        const repeated = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(recovered.next_gate, 'quality-checklist', recovered.reason);
        assert.equal(recovered.commands.length, 0);
        assert.match(recovered.reason, /existing repair candidate preserved/iu);
        assert.equal(fs.readFileSync(repairPath, 'utf8'), '{invalid repair json');
        assert.equal(fs.readFileSync(recoveryPath, 'utf8'), recoveryBytes);
        assert.equal(repeated.commands.length, 0);
    });

    it('routes through a rotated recovery path when both fixed repair candidates are unsafe', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        const repairPath = qualityChecklistRepairAnswersPath(repoRoot);
        const recoveryPath = qualityChecklistRecoveryAnswersPath(repoRoot);
        fs.mkdirSync(path.dirname(answersPath), { recursive: true });
        fs.writeFileSync(answersPath, '{unsafe canonical json', 'utf8');
        fs.writeFileSync(repairPath, '{unsafe repair json', 'utf8');
        fs.writeFileSync(recoveryPath, '{unsafe recovery json', 'utf8');

        const recovered = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const rotatedRecoveryPath = qualityChecklistRotatedRecoveryAnswersPath(repoRoot);
        const rotatedRecoveryBytes = fs.readFileSync(rotatedRecoveryPath, 'utf8');
        const repeated = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(recovered.next_gate, 'quality-checklist', recovered.reason);
        assert.equal(recovered.commands.length, 0);
        assert.match(recovered.reason, /existing repair candidate preserved/iu);
        assert.equal(fs.readFileSync(answersPath, 'utf8'), '{unsafe canonical json');
        assert.equal(fs.readFileSync(repairPath, 'utf8'), '{unsafe repair json');
        assert.equal(fs.readFileSync(recoveryPath, 'utf8'), '{unsafe recovery json');
        assert.equal(fs.readFileSync(rotatedRecoveryPath, 'utf8'), rotatedRecoveryBytes);
        assert.equal(repeated.commands.length, 0);
    });

    it('routes tampered slim-scaffold answers templates through a repair answers path', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        resolveNextStep({ taskId: TASK_ID, repoRoot });
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
            answers: Array<Record<string, unknown>>;
        };
        template.answers[0] = {
            ...template.answers[0],
            prompt: 'Tampered prompt field should not be accepted in the slim scaffold.'
        };
        fs.writeFileSync(answersPath, JSON.stringify(template, null, 2) + '\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.commands.length, 0);
        assert.equal(normalizeTestPath(result.quality_checklist?.answers_template_path), normalizeTestPath(qualityChecklistRepairAnswersPath(repoRoot)));
        assert.match(result.reason, /editable fields do not match the slim active-rule scaffold/u);
    });

    it('routes stale answers templates with mismatched binding through a repair answers path', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        resolveNextStep({ taskId: TASK_ID, repoRoot });
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
            preflight_sha256: string;
        };
        template.preflight_sha256 = '0'.repeat(64);
        fs.writeFileSync(answersPath, JSON.stringify(template, null, 2) + '\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.commands.length, 0);
        assert.equal(normalizeTestPath(result.quality_checklist?.answers_template_path), normalizeTestPath(qualityChecklistRepairAnswersPath(repoRoot)));
        assert.match(result.reason, /current preflight/u);
        assert.match(result.reason, /Existing binding is missing or does not match the stale answers template/u);
    });

    it('preserves filled answers when test-review failure cadence rematerializes after a preflight refresh', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        initializeWorkspaceBaseline(repoRoot, [
            'tests/first-test-review-fix.test.ts',
            'tests/after-review-failure-refresh.test.ts'
        ]);
        writeWorkspaceChange(repoRoot, 'src/app.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');
        appendReviewFailure(repoRoot, 'test');
        restoreWorkspaceChanges(repoRoot, 'src/app.ts');
        writeWorkspaceChange(repoRoot, 'tests/first-test-review-fix.test.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, test: true }, {
            changedFiles: ['tests/first-test-review-fix.test.ts'],
            scopeCategory: 'test-only'
        });

        const first = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(first.next_gate, 'quality-checklist', first.reason);

        const answersPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            `${TASK_ID}-quality-checklist-answers.json`
        );
        const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
            preflight_sha256: string;
            answers: Array<Record<string, unknown>>;
        };
        template.answers = template.answers.map((answer) => ({
            ...answer,
            status: 'PASS',
            answer: `Filled cadence answer for ${String(answer.rule_id)}.`
        }));
        fs.writeFileSync(answersPath, JSON.stringify(template, null, 2) + '\n', 'utf8');

        writeWorkspaceChange(repoRoot, 'tests/after-review-failure-refresh.test.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, test: true }, {
            changedFiles: ['tests/first-test-review-fix.test.ts', 'tests/after-review-failure-refresh.test.ts'],
            scopeCategory: 'test-only'
        });

        const second = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(second.next_gate, 'quality-checklist', second.reason);
        const refreshedTemplate = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
            preflight_sha256: string;
            answers: Array<Record<string, unknown>>;
        };
        assert.notEqual(refreshedTemplate.preflight_sha256, template.preflight_sha256);
        assert.ok(refreshedTemplate.answers.length > 0);
        assert.ok(refreshedTemplate.answers.every((answer) => answer.status === 'PASS'));
        assert.ok(refreshedTemplate.answers.every((answer) => (
            String(answer.answer || '').startsWith('Filled cadence answer for ')
        )));
    });

    it('does not write the active-question reference through a symlinked runtime tmp path', () => {
        const repoRoot = makeTempRepo();
        const outsideDir = path.join(path.dirname(repoRoot), `${TASK_ID}-outside-runtime-tmp`);
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        fs.mkdirSync(outsideDir, { recursive: true });
        const runtimeRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
        fs.mkdirSync(runtimeRoot, { recursive: true });
        const tmpPath = path.join(runtimeRoot, 'tmp');
        try {
            fs.symlinkSync(outsideDir, tmpPath, 'dir');
        } catch (error: unknown) {
            if (process.platform === 'win32') {
                return;
            }
            throw error;
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.match(result.reason, /active-question reference path must not contain symbolic links/u);
        assert.equal(
            fs.existsSync(path.join(outsideDir, `${TASK_ID}-quality-checklist-questions.md`)),
            false
        );
    });

    it('preserves current partial answers after answer validation records CONFIG_ERROR', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        resolveNextStep({ taskId: TASK_ID, repoRoot });
        const answersPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            `${TASK_ID}-quality-checklist-answers.json`
        );
        const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
            answers: Array<Record<string, unknown>>;
        };
        template.answers[0] = {
            ...template.answers[0],
            status: 'PASS',
            answer: 'The first completed answer must survive CONFIG_ERROR recovery.'
        };
        fs.writeFileSync(answersPath, JSON.stringify(template, null, 2) + '\n', 'utf8');
        const partialAnswers = fs.readFileSync(answersPath, 'utf8');

        const checklistResult = runQualityChecklistCommand({
            repoRoot,
            taskId: TASK_ID,
            preflightPath: path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`),
            answersPath,
            emitMetrics: false
        });
        assert.equal(checklistResult.exitCode, 3);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.quality_checklist?.status, 'CONFIG_ERROR');
        assert.deepEqual(fs.readFileSync(answersPath, 'utf8'), partialAnswers);
        assert.equal(result.commands.length, 0);
    });

    it('returns a repair route without an answers path when template materialization fails', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            configure(config) {
                config.optional_quality_checks.rules.push({ ...config.optional_quality_checks.rules[0] });
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.commands.length, 0);
        assert.match(result.reason, /Answers template was not materialized/u);
        assert.match(result.reason, /duplicate quality-check rule id/u);
        assert.equal(fs.existsSync(path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            `${TASK_ID}-quality-checklist-answers.json`
        )), false);
    });

    it('routes an unusable default template directory through a repair answers path', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const answersPath = qualityChecklistAnswersPath(repoRoot);
        fs.mkdirSync(answersPath, { recursive: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.commands.length, 0);
        assert.equal(fs.statSync(answersPath).isDirectory(), true);
        assert.ok(fs.existsSync(qualityChecklistRepairAnswersPath(repoRoot)));
        assert.match(result.reason, /Answers template was not materialized/u);
    });

    it('prints a shorter active-rule requirement for test-only quality checklist scope', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        initializeWorkspaceBaseline(repoRoot, ['tests/node/gates/quality-checklist/quality-checklist.test.ts']);
        writeWorkspaceChange(repoRoot, 'tests/node/gates/quality-checklist/quality-checklist.test.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, test: true }, {
            scopeCategory: 'test-only',
            changedFiles: ['tests/node/gates/quality-checklist/quality-checklist.test.ts']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.quality_checklist?.scope_category, 'test-only');
        assert.equal(result.quality_checklist?.enabled_rule_count, 11);
        assert.equal(result.quality_checklist?.active_rule_count, 4);
        assert.equal(result.quality_checklist?.skipped_by_scope_rule_count, 7);
        assert.match(result.reason, /Active rules for scope "test-only": 4; skipped_by_scope=7/u);
        const answersTemplate = JSON.parse(fs.readFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', `${TASK_ID}-quality-checklist-answers.json`),
            'utf8'
        )) as { answers: unknown[] };
        assert.equal(answersTemplate.answers.length, 4);
        assert.equal(result.commands.length, 0);
    });

    it('includes canonical rule ids when stale moved rule config needs checklist answers', () => {
        const repoRoot = makeTempRepo();
        writeStaleMovedRuleWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.ok(result.reason.includes(
            `baseline_version '2026-06-26.t843' differs from shipped '${OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION}'`
        ));
        assert.match(result.reason, /classifier_intent_edge_cases/u);
        assert.match(result.reason, /custom_garda_classifier_intent_edge_cases/u);
        assert.match(result.reason, /Canonical enabled quality-check rule ids/u);
        assert.match(result.reason, /deprecated or moved ids are not accepted/u);
        assert.equal(result.commands.length, 0);
    });

    it('routes missing quality checklist before after-compile full-suite recovery', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            fullSuiteEnabled: true,
            fullSuitePlacement: 'after_compile_before_reviews'
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, { reviewPolicyMode: 'parallel_all' });
        seedCompilePass(repoRoot, TASK_ID, undefined, { qualityChecklist: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.commands.length, 0);
    });

    it('skips quality checklist routing when optional checks are disabled', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, { optionalQualityChecksEnabled: false });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.equal(result.quality_checklist?.evidence_status, 'disabled');
        assert.equal(result.quality_checklist?.effect, 'disabled');
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
    });

    it('continues to compile after current PASS quality checklist evidence', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');
        const questionReferencePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            `${TASK_ID}-quality-checklist-questions.md`
        );

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.equal(result.quality_checklist?.evidence_status, 'current');
        assert.equal(result.quality_checklist?.status, 'PASS');
        assert.equal(result.quality_checklist?.effect, 'passed');
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
        assert.equal(fs.existsSync(questionReferencePath), false);
    });

    it('skips the first two review failures and requires answers on the third', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        initializeWorkspaceBaseline(repoRoot, [
            'src/cadence-fix-1.ts',
            'src/cadence-fix-2.ts',
            'src/cadence-fix-3.ts'
        ]);
        writeWorkspaceChange(repoRoot, 'src/app.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');

        for (const failureCount of [1, 2, 3]) {
            appendReviewFailure(repoRoot);
            restoreWorkspaceChanges(
                repoRoot,
                failureCount === 1 ? 'src/app.ts' : `src/cadence-fix-${failureCount - 1}.ts`
            );
            writeWorkspaceChange(repoRoot, `src/cadence-fix-${failureCount}.ts`);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
                changedFiles: [`src/cadence-fix-${failureCount}.ts`]
            });
            if (failureCount < 3) {
                const readiness = readCurrentQualityChecklistReadiness(repoRoot);
                assert.equal(readiness.status, 'SKIPPED_CADENCE');
                assert.equal(readiness.effect, 'skipped_cadence');
                assert.equal(readiness.reviewFailureCadenceInterval, 3);
            } else {
                const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
                assert.equal(result.next_gate, 'quality-checklist', result.reason);
                assert.equal(result.quality_checklist?.review_failure_cadence_interval, 3);
                assert.match(result.quality_checklist?.visible_summary_line || '', /review_failure_cadence_interval=3/u);
            }
        }
    });

    it('surfaces answer validation failures when review-failure cadence requires fresh evidence', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            configure(config) {
                config.optional_quality_checks.review_failure_cadence_interval = 1;
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        initializeWorkspaceBaseline(repoRoot, ['src/cadence-fix.ts']);
        writeWorkspaceChange(repoRoot, 'src/app.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');
        appendReviewFailure(repoRoot);
        restoreWorkspaceChanges(repoRoot, 'src/app.ts');
        writeWorkspaceChange(repoRoot, 'src/cadence-fix.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/cadence-fix.ts']
        });

        const stale = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(stale.quality_checklist?.evidence_status, 'stale', stale.reason);
        const answerCount = completeChecklistAnswersWithInvalidFirstStatus(repoRoot);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.commands.length, 0);
        assert.equal(result.quality_checklist?.evidence_status, 'invalid');
        assert.equal(result.quality_checklist?.status, 'CONFIG_ERROR');
        assert.equal(result.quality_checklist?.answer_count, answerCount - 1);
        assert.match(result.reason, /Completed quality checklist answers failed validation/u);
        assert.match(result.reason, /Missing answer for active quality-check rule 'code_simplification'/u);
    });

    it('does not cadence-skip mandatory trust-boundary analysis after a review failure', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        const sensitivePath = 'src/gates/review-context/trust-fix.ts';
        initializeWorkspaceBaseline(repoRoot, [sensitivePath]);
        writeWorkspaceChange(repoRoot, 'src/app.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');

        appendReviewFailure(repoRoot);
        restoreWorkspaceChanges(repoRoot, 'src/app.ts');
        writeWorkspaceChange(repoRoot, sensitivePath);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: [sensitivePath]
        });
        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.notEqual(result.quality_checklist?.status, 'SKIPPED_CADENCE');
        assert.notEqual(result.quality_checklist?.effect, 'skipped_cadence');
    });

    it('uses configured review-failure cadence interval boundaries', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            configure(config) {
                config.optional_quality_checks.review_failure_cadence_interval = 2;
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        initializeWorkspaceBaseline(repoRoot, ['src/cadence-fix-one.ts', 'src/cadence-fix-two.ts']);
        writeWorkspaceChange(repoRoot, 'src/app.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');

        appendReviewFailure(repoRoot);
        restoreWorkspaceChanges(repoRoot, 'src/app.ts');
        writeWorkspaceChange(repoRoot, 'src/cadence-fix-one.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/cadence-fix-one.ts']
        });
        const first = readCurrentQualityChecklistReadiness(repoRoot);

        assert.equal(first.status, 'SKIPPED_CADENCE');
        assert.equal(first.effect, 'skipped_cadence');
        assert.equal(first.reviewFailureCadenceInterval, 2);

        appendReviewFailure(repoRoot);
        restoreWorkspaceChanges(repoRoot, 'src/cadence-fix-one.ts');
        writeWorkspaceChange(repoRoot, 'src/cadence-fix-two.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/cadence-fix-two.ts']
        });
        const second = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(second.next_gate, 'quality-checklist', second.reason);
        assert.equal(second.quality_checklist?.review_failure_cadence_interval, 2);
        assert.match(second.reason, /review_failure_cadence_interval=2 was reached/u);
    });

    it('recognizes a canonical failed review whose lifecycle event records materialization success', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        initializeWorkspaceBaseline(repoRoot, ['src/canonical-cadence-fix.ts']);
        writeWorkspaceChange(repoRoot, 'src/app.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');
        appendCanonicalReviewFailure(repoRoot);
        restoreWorkspaceChanges(repoRoot, 'src/app.ts');
        writeWorkspaceChange(repoRoot, 'src/canonical-cadence-fix.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/canonical-cadence-fix.ts']
        });

        const readiness = readCurrentQualityChecklistReadiness(repoRoot);

        assert.equal(readiness.status, 'SKIPPED_CADENCE');
        assert.equal(readiness.effect, 'skipped_cadence');
    });

    it('counts every independent review lane failure toward quality-checklist cadence', () => {
        for (const reviewType of ['db', 'refactor', 'api', 'infra', 'dependency'] as const) {
            const repoRoot = makeTempRepo();
            writeWorkflowConfig(repoRoot);
            seedStartedTask(repoRoot, TASK_ID);
            initializeWorkspaceBaseline(repoRoot, [`src/${reviewType}-cadence-fix.ts`]);
            writeWorkspaceChange(repoRoot, 'src/app.ts');
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, [reviewType]: true });
            writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');
            appendReviewFailure(repoRoot, reviewType);
            restoreWorkspaceChanges(repoRoot, 'src/app.ts');
            writeWorkspaceChange(repoRoot, `src/${reviewType}-cadence-fix.ts`);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, [reviewType]: true }, {
                changedFiles: [`src/${reviewType}-cadence-fix.ts`]
            });

            const readiness = readCurrentQualityChecklistReadiness(repoRoot);

            assert.equal(readiness.status, 'SKIPPED_CADENCE', reviewType);
            assert.equal(readiness.effect, 'skipped_cadence', reviewType);
            if (reviewType === 'db') {
                const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
                assert.equal(result.quality_checklist?.status, 'SKIPPED_CADENCE', reviewType);
                assert.equal(result.quality_checklist?.effect, 'skipped_cadence', reviewType);
                assert.equal(result.quality_checklist?.review_failure_cadence_interval, 3);
                assert.match(
                    result.quality_checklist?.visible_summary_line || '',
                    /review_failure_cadence_interval=3/u
                );
                assert.notEqual(result.next_gate, 'quality-checklist');
            }
        }
    });

    it('records a distinct cadence skip when another review fails without a preflight change', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');
        appendReviewFailure(repoRoot);
        readCurrentQualityChecklistReadiness(repoRoot);
        appendReviewFailure(repoRoot);

        const second = readCurrentQualityChecklistReadiness(repoRoot);
        const skipArtifact = JSON.parse(fs.readFileSync(path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${TASK_ID}-quality-checklist.json`
        ), 'utf8')) as Record<string, unknown>;

        assert.equal(second.status, 'SKIPPED_CADENCE');
        assert.equal(skipArtifact.review_failure_count, 2);

        appendReviewFailure(repoRoot);
        const third = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(third.next_gate, 'quality-checklist', third.reason);
    });

    it('refreshes cadence skip evidence when workflow rule order changes under the same failure count', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');
        appendReviewFailure(repoRoot);

        const first = readCurrentQualityChecklistReadiness(repoRoot);
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-quality-checklist.json`);
        const firstArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        const firstWorkflowConfigSha256 = String(firstArtifact.workflow_config_sha256 || '');

        writeWorkflowConfig(repoRoot, {
            configure(config) {
                config.optional_quality_checks.rules = [...config.optional_quality_checks.rules].reverse();
            }
        });
        const currentWorkflowConfigSha256 = fileSha256(workflowConfigPath(repoRoot));

        const second = readCurrentQualityChecklistReadiness(repoRoot);
        const secondArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;

        assert.equal(first.status, 'SKIPPED_CADENCE');
        assert.equal(second.status, 'SKIPPED_CADENCE');
        assert.equal(second.effect, 'skipped_cadence');
        assert.equal(secondArtifact.review_failure_count, 1);
        assert.notEqual(currentWorkflowConfigSha256, firstWorkflowConfigSha256);
        assert.equal(secondArtifact.workflow_config_sha256, currentWorkflowConfigSha256);
    });

    it('does not advance the failure counter for diff changes or repeated next-step calls', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');
        appendReviewFailure(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { changedFiles: ['src/a.ts'] });
        const first = resolveNextStep({ taskId: TASK_ID, repoRoot });
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { changedFiles: ['src/b.ts'] });
        const changedDiff = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const repeated = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(first.quality_checklist?.status, 'SKIPPED_CADENCE');
        assert.equal(changedDiff.quality_checklist?.status, 'SKIPPED_CADENCE');
        assert.equal(repeated.quality_checklist?.status, 'SKIPPED_CADENCE');
    });

    it('does not advance the operator-defined review-failure counter for compile or suite failures', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');
        appendEvent(repoRoot, TASK_ID, 'COMPILE_GATE_FAILED', 'FAIL', {});
        appendEvent(repoRoot, TASK_ID, 'FULL_SUITE_VALIDATION_FAILED', 'FAIL', {});
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['src/non-review-remediation.ts']
        });

        const readiness = readCurrentQualityChecklistReadiness(repoRoot);

        assert.equal(readiness.status, 'PASS');
        assert.notEqual(readiness.effect, 'skipped_cadence');
    });

    it('uses the first test-review failure as a one-time forced reset', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        initializeWorkspaceBaseline(repoRoot, [
            'tests/test-review-fix.test.ts',
            'tests/second-test-review-fix.test.ts'
        ]);
        writeWorkspaceChange(repoRoot, 'src/app.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');
        appendReviewFailure(repoRoot, 'test');
        restoreWorkspaceChanges(repoRoot, 'src/app.ts');
        writeWorkspaceChange(repoRoot, 'tests/test-review-fix.test.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['tests/test-review-fix.test.ts'],
            scopeCategory: 'test-only'
        });
        const forced = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(forced.next_gate, 'quality-checklist', forced.reason);

        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', { scopeCategory: 'test-only' });
        appendReviewFailure(repoRoot, 'test');
        restoreWorkspaceChanges(repoRoot, 'tests/test-review-fix.test.ts');
        writeWorkspaceChange(repoRoot, 'tests/second-test-review-fix.test.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
            changedFiles: ['tests/second-test-review-fix.test.ts'],
            scopeCategory: 'test-only'
        });
        const ordinary = readCurrentQualityChecklistReadiness(repoRoot);
        assert.equal(ordinary.status, 'SKIPPED_CADENCE');
    });

    it('marks current PASS quality checklist evidence as helped when actions were taken', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', {
            actionsTaken: ['Extracted the quality gate evidence helper before continuing.']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.equal(result.quality_checklist?.evidence_status, 'current');
        assert.equal(result.quality_checklist?.status, 'PASS');
        assert.equal(result.quality_checklist?.effect, 'helped');
        assert.equal(result.quality_checklist?.actions_taken_count, 1);
        assert.match(result.quality_checklist?.visible_summary_line || '', /effect=helped/u);
    });

    it('continues to review context after compile without rerunning current PASS evidence', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.ok(result.commands[0].command.includes('gate build-review-context'));
        assert.ok(!result.commands[0].command.includes('gate quality-checklist'));
    });

    it('continues through after-compile full-suite after accepted WARN evidence', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            fullSuiteEnabled: true,
            fullSuitePlacement: 'after_compile_before_reviews'
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, { reviewPolicyMode: 'parallel_all' });
        seedCompilePass(repoRoot, TASK_ID);
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'WARN');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'full-suite-validation', result.reason);
        assert.ok(result.commands[0].command.includes('gate full-suite-validation'));
    });

    it('routes ACTION_REQUIRED quality checklist evidence back to implementation', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'ACTION_REQUIRED');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'implementation', result.reason);
        assert.equal(result.quality_checklist?.effect, 'required_rework');
        assert.equal(result.quality_checklist?.actions_required_count, 1);
        assert.equal(result.commands.length, 0);
        assert.match(result.reason, /Simplify the routing helper/);
    });

    it('prints the checklist rerun command after ACTION_REQUIRED answers are remediated', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'ACTION_REQUIRED');

        const blocked = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(blocked.next_gate, 'implementation', blocked.reason);

        const answersPath = qualityChecklistAnswersPath(repoRoot);
        const answersTemplate = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
            answers: Array<Record<string, unknown>>;
        };
        answersTemplate.answers = answersTemplate.answers.map((answer) => ({
            ...answer,
            status: 'PASS',
            answer: `Remediated ${String(answer.rule_id)}.`,
            actions_required: [],
            actions_taken: [`Resolved ${String(answer.rule_id)} action.`]
        }));
        fs.writeFileSync(answersPath, JSON.stringify(answersTemplate, null, 2) + '\n', 'utf8');

        const rerun = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(rerun.next_gate, 'quality-checklist', rerun.reason);
        assert.equal(rerun.commands.length, 1);
        assert.match(rerun.commands[0].command, /gate quality-checklist/u);
        assert.match(rerun.commands[0].command, /quality-checklist-answers\.json/u);
        assert.match(rerun.reason, /updated after ACTION_REQUIRED remediation/u);
    });

    it('keeps T-839-derived ACTION_REQUIRED checklist findings ahead of full-suite and review routing', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            fullSuiteEnabled: true,
            fullSuitePlacement: 'after_compile_before_reviews'
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, { reviewPolicyMode: 'parallel_all' });
        seedCompilePass(repoRoot, TASK_ID, undefined, { qualityChecklist: false });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'ACTION_REQUIRED', {
            actionsRequired: [...T839_DERIVED_QUALITY_ACTIONS]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'implementation', result.reason);
        assert.equal(result.quality_checklist?.effect, 'required_rework');
        assert.equal(result.quality_checklist?.actions_required_count, T839_DERIVED_QUALITY_ACTIONS.length);
        assert.equal(result.commands.length, 0);
        assert.ok(!result.reason.includes('full-suite-validation'));
        assert.ok(!result.reason.includes('build-review-context'));
        assert.match(result.reason, /preflight and review scope/);
    });

    it('reruns quality checklist when prior evidence is stale for the current preflight', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', {
            preflightSha256: '0'.repeat(64)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.quality_checklist?.evidence_status, 'stale');
        assert.equal(result.quality_checklist?.effect, 'stale');
        assert.match(result.reason, /stale for the current preflight hash/);
    });

    it('accepts prior quality checklist evidence after compatible workflow config normalization', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', {
            workflowConfigSha256: '0'.repeat(64),
            rules: buildQualityChecklistRuleSnapshot({
                titlePrefix: 'Old shipped title: ',
                promptPrefix: 'Old shipped prompt: '
            }),
            answers: buildQualityChecklistAnswers()
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.quality_checklist?.evidence_status, 'current');
        assert.notEqual(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.next_gate, 'compile-gate', result.reason);
    });

    it('accepts compatible baseline user disable overrides after workflow config normalization', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            configure(config) {
                const rule = config.optional_quality_checks.rules.find((candidate) => candidate.id === 'project_style_fit');
                assert.ok(rule);
                rule.enabled = false;
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const config = JSON.parse(fs.readFileSync(workflowConfigPath(repoRoot), 'utf8')) as WorkflowConfig;
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', {
            workflowConfigSha256: '0'.repeat(64),
            rules: buildQualityChecklistRuleSnapshot({
                rules: config.optional_quality_checks.rules,
                titlePrefix: 'Previous shipped title: ',
                promptPrefix: 'Previous shipped prompt: '
            }),
            answers: buildQualityChecklistAnswers({ rules: config.optional_quality_checks.rules })
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.quality_checklist?.evidence_status, 'current');
        assert.notEqual(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.next_gate, 'compile-gate', result.reason);
    });

    it('accepts unchanged custom quality rules after unrelated workflow config normalization', () => {
        const customRule = {
            id: 'custom_team_release_safety',
            title: 'Team release safety',
            prompt: 'Check team release safeguards.',
            enabled: true
        };
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            configure(config) {
                config.optional_quality_checks.rules = [...config.optional_quality_checks.rules, customRule];
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const config = JSON.parse(fs.readFileSync(workflowConfigPath(repoRoot), 'utf8')) as WorkflowConfig;
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', {
            workflowConfigSha256: '0'.repeat(64),
            rules: buildQualityChecklistRuleSnapshot({ rules: config.optional_quality_checks.rules }),
            answers: buildQualityChecklistAnswers({ rules: config.optional_quality_checks.rules })
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.quality_checklist?.evidence_status, 'current');
        assert.notEqual(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.next_gate, 'compile-gate', result.reason);
    });

    it('reruns quality checklist when a custom quality rule changes after config normalization', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            configure(config) {
                config.optional_quality_checks.rules = [
                    ...config.optional_quality_checks.rules,
                    {
                        id: 'custom_team_release_safety',
                        title: 'Team release safety',
                        prompt: 'Check updated team release safeguards.',
                        enabled: true
                    }
                ];
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const artifactConfig = buildDefaultWorkflowConfig();
        artifactConfig.optional_quality_checks.rules = [
            ...artifactConfig.optional_quality_checks.rules,
            {
                id: 'custom_team_release_safety',
                title: 'Team release safety',
                prompt: 'Check original team release safeguards.',
                enabled: true
            }
        ];
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', {
            workflowConfigSha256: '0'.repeat(64),
            rules: buildQualityChecklistRuleSnapshot({ rules: artifactConfig.optional_quality_checks.rules }),
            answers: buildQualityChecklistAnswers({ rules: artifactConfig.optional_quality_checks.rules })
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.quality_checklist?.evidence_status, 'stale');
        assert.match(result.reason, /custom_team_release_safety/u);
        assert.match(result.reason, /Custom quality-check rule .* changed/u);
    });

    it('surfaces answer validation failures when workflow configuration makes prior evidence stale', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot, {
            configure(config) {
                config.optional_quality_checks.rules = [
                    ...config.optional_quality_checks.rules,
                    {
                        id: 'custom_team_release_safety',
                        title: 'Team release safety',
                        prompt: 'Check updated team release safeguards.',
                        enabled: true
                    }
                ];
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const artifactConfig = buildDefaultWorkflowConfig();
        artifactConfig.optional_quality_checks.rules = [
            ...artifactConfig.optional_quality_checks.rules,
            {
                id: 'custom_team_release_safety',
                title: 'Team release safety',
                prompt: 'Check original team release safeguards.',
                enabled: true
            }
        ];
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', {
            workflowConfigSha256: '0'.repeat(64),
            rules: buildQualityChecklistRuleSnapshot({ rules: artifactConfig.optional_quality_checks.rules }),
            answers: buildQualityChecklistAnswers({ rules: artifactConfig.optional_quality_checks.rules })
        });

        const stale = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(stale.quality_checklist?.evidence_status, 'stale', stale.reason);
        const answerCount = completeChecklistAnswersWithInvalidFirstStatus(repoRoot);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.commands.length, 0);
        assert.equal(result.quality_checklist?.evidence_status, 'invalid');
        assert.equal(result.quality_checklist?.status, 'CONFIG_ERROR');
        assert.equal(result.quality_checklist?.answer_count, answerCount - 1);
        assert.match(result.reason, /Completed quality checklist answers failed validation/u);
        assert.match(result.reason, /Missing answer for active quality-check rule 'code_simplification'/u);
    });

    it('reruns quality checklist when a current active baseline rule has no recorded answer after config normalization', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', {
            workflowConfigSha256: '0'.repeat(64),
            rules: buildQualityChecklistRuleSnapshot(),
            answers: buildQualityChecklistAnswers({ omitRuleIds: ['project_style_fit'] })
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.quality_checklist?.evidence_status, 'stale');
        assert.equal(result.quality_checklist?.effect, 'stale');
        assert.match(result.reason, /project_style_fit/u);
        assert.match(result.reason, /missing from the recorded checklist answers/u);
    });

    it('reruns quality checklist when normalized evidence contains duplicate answers', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', {
            workflowConfigSha256: '0'.repeat(64),
            rules: buildQualityChecklistRuleSnapshot(),
            answers: [
                ...buildQualityChecklistAnswers(),
                {
                    rule_id: 'project_style_fit',
                    status: 'PASS',
                    answer: 'Duplicate answer should invalidate compatibility.'
                }
            ]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.quality_checklist?.evidence_status, 'stale');
        assert.match(result.reason, /project_style_fit/u);
        assert.match(result.reason, /more than once/u);
    });

    it('reruns quality checklist when normalized evidence answers a skipped rule for test-only scope', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        initializeWorkspaceBaseline(repoRoot, ['tests/node/gates/quality-checklist/quality-checklist.test.ts']);
        writeWorkspaceChange(repoRoot, 'tests/node/gates/quality-checklist/quality-checklist.test.ts');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, test: true }, {
            scopeCategory: 'test-only',
            changedFiles: ['tests/node/gates/quality-checklist/quality-checklist.test.ts']
        });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS', {
            workflowConfigSha256: '0'.repeat(64),
            scopeCategory: 'test-only',
            rules: buildQualityChecklistRuleSnapshot(),
            answers: buildQualityChecklistAnswers()
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'quality-checklist', result.reason);
        assert.equal(result.quality_checklist?.evidence_status, 'stale');
        assert.match(result.reason, /code_simplification/u);
        assert.match(result.reason, /currently skipped_by_scope/u);
    });

    it('marks quality checklist summary stale when current workspace drifts after PASS evidence', () => {
        const repoRoot = makeTempRepo();
        writeWorkflowConfig(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        writeQualityChecklistArtifact(repoRoot, TASK_ID, 'PASS');
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const qualityChecklistDrift = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.equal(result.quality_checklist?.evidence_status, 'stale');
        assert.equal(result.quality_checklist?.effect, 'stale');
        assert.match(result.quality_checklist?.visible_summary_line || '', /evidence=stale/u);
        assert.match(result.reason, /preflight .*differs from current/u);
    });
});
