import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES,
    OPS_SHELL_OPTIONAL_QUALITY_CHECK_RULES,
    buildDefaultWorkflowConfig,
    isOptionalQualityCheckRuleActiveForScope,
    isOptionalQualityCheckRuleExcludedForScope
} from '../../../../src/core/workflow-config';
import {
    buildQualityChecklistArtifact,
    buildQualityChecklistAnswersTemplate,
    buildQualityChecklistCadenceSkipArtifact,
    materializeQualityChecklistAnswersTemplate
} from '../../../../src/gates/quality-checklist';
import {
    runQualityChecklistCommand
} from '../../../../src/cli/commands/gate-flows/quality-checklist/quality-checklist-flow';
import {
    TRUST_BOUNDARY_ANALYSIS_RULE_ID
} from '../../../../src/core/trust-boundary-analysis';
import {
    createGateFixture,
    writeGateFixturePreflight
} from '../../gate-fixtures';
import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { runClassifyChangeCommand } from '../../../../src/cli/commands/gates';
import { executeValidationRecipe } from '../../../../src/gates/project-validation/execution';
import { evaluateValidationAttempt } from '../../../../src/gates/project-validation/result-evaluation';
import { createTempRepo, initializeGitRepo, loadTaskEntryRulePack, runEnterTaskMode, runHandshakeForTask, runShellSmokeForTask, seedInitAnswers, seedTaskQueue }
    from '../../cli/commands/gates/preflight/gates-preflight-fixtures';
import { removeTempRepoWithRetry } from '../../cli/commands/gate-test-repo-bootstrap';

function declaredQualityFixture(mode = 'passed', targetlessMode?: string, optionalChecksEnabled = true) {
    const root = createTempRepo(), orchestratorRoot = path.join(root, 'garda-agent-orchestrator');
    const fixture = { repoRoot: root, orchestratorRoot, reviewsRoot: path.join(orchestratorRoot, 'runtime/reviews'),
        taskId: 'T-quality-phase', cleanup: () => removeTempRepoWithRetry(root) };
    const configPath = path.join(fixture.orchestratorRoot, 'live/config/workflow-config.json');
    const config = buildDefaultWorkflowConfig();
    config.optional_quality_checks.enabled = optionalChecksEnabled;
    fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, JSON.stringify(config));
    fs.mkdirSync(path.join(root, 'src/security'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/security/evidence.ts'), 'export const boundary = 1;\n');
    fs.writeFileSync(path.join(root, 'RootSuite'), 'declared source with unknown syntax');
    fs.writeFileSync(path.join(root, 'driver'), 'process.stdout.write(process.argv[2]==="opaque"?"unknown success":"TAP version 13\\n"+(process.argv[2]==="failed"?"not ok":"ok")+" 1 - declared case\\n1..1\\n");process.exitCode=process.argv[2]==="failed"?7:0;');
    const recipe = { id: 'neutral', purpose: 'test', executable: process.execPath,
        argv: ['driver', mode, { target: 'opaque-1' }], cwd: '.', environment: {},
        inputs: [{ path: 'src/security/evidence.ts', role: 'source' }, { path: 'RootSuite', role: 'test' }, { path: 'driver', role: 'helper' }],
        targets: [{ id: 'opaque-1', source: 'RootSuite', selector: 'declared case' }], timeout_ms: 5000,
        max_attempts: 3, max_output_bytes: 1024, max_input_bytes: 65536, required_capabilities: [], result_format: 'tap' };
    const recipes = targetlessMode === undefined ? [recipe] : [recipe,
        { ...recipe, id: 'compile', purpose: 'compile', argv: ['driver', targetlessMode], targets: [] }];
    fs.writeFileSync(path.join(root, 'recipes.json'), JSON.stringify({ schema_version: 1, recipes }));
    seedInitAnswers(root); seedTaskQueue(root, fixture.taskId, 'TODO', 'default', 'Required reviews: code, security, test.', 'Security validation phase evidence');
    initializeGitRepo(root);
    handleWorkflow(['set', '--target-root', root, '--project-validation-contract', 'recipes.json', '--operator-confirmed', 'yes',
        '--operator-confirmed-at-utc', new Date().toISOString()], { name: 'garda-agent-orchestrator', version: '1.0.0' });
    runEnterTaskMode({ repoRoot: root, taskId: fixture.taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2,
        taskSummary: 'Security validation phase evidence', provider: 'Codex' });
    loadTaskEntryRulePack(root, fixture.taskId); runHandshakeForTask(root, fixture.taskId); runShellSmokeForTask(root, fixture.taskId);
    fs.appendFileSync(path.join(root, 'src/security/evidence.ts'), '\nexport const phase = 1;\n');
    fs.appendFileSync(path.join(root, 'RootSuite'), '\ncurrent declared source\n');
    const preflightPath = path.join(fixture.reviewsRoot, `${fixture.taskId}-preflight.json`);
    runClassifyChangeCommand({ repoRoot: root, taskId: fixture.taskId, taskIntent: 'Security validation phase evidence',
        outputPath: preflightPath, changedFiles: ['src/security/evidence.ts', 'RootSuite'], emitMetrics: false });
    const answer = buildTrustBoundaryAnswer(), matrix = answer.trust_boundary_matrix as Array<Record<string, unknown>>;
    matrix[0].negative_paths = [{ kind: 'other', scenario: 'проверка', expected_behavior: 'Block invalid evidence.', evidence_files: ['RootSuite#opaque-1'] }];
    const answers = buildQualityChecklistAnswersTemplate({ repoRoot: root, taskId: fixture.taskId, preflightPath }).answers
        .map(entry => entry.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID ? answer : { ...entry, status: 'PASS', answer: 'Checked current scope.' });
    return { ...fixture, answers,
        artifact: (currentAnswers = answers) => buildQualityChecklistArtifact({ repoRoot: root, taskId: fixture.taskId, preflightPath, answers: currentAnswers }),
        execute: async (signal?: AbortSignal, recipeId = 'neutral') => {
            const attempt = await executeValidationRecipe({ repoRoot: root, taskId: fixture.taskId, recipeId, signal });
            return evaluateValidationAttempt({ repoRoot: root, taskId: fixture.taskId, attemptId: attempt.attempt_id });
        } };
}

function declaredPhases(artifact: ReturnType<typeof buildQualityChecklistArtifact>) {
    return (artifact as typeof artifact & { validation_phases?: {
        structural: string; execution: string; semantic: string; sha256: string;
        executions: Array<{ recipe_id: string; attempt_id: string | null; result_sha256: string | null }>;
        obligations: Array<{ id: string; recipe_id: string; target_id: string; source_identity: { path: string; sha256: string }; result_status: string | null }>;
    } }).validation_phases;
}

const UNIVERSAL_QUALITY_RULE_EXPECTATIONS = Object.freeze([
    Object.freeze({
        id: 'code_simplification',
        promptPatterns: [/simplified/i, /behavior/i, /diagnostics/i],
        action: 'Simplify the changed code without weakening behavior, validation, or diagnostics.'
    }),
    Object.freeze({
        id: 'project_style_fit',
        promptPatterns: [/project style/i, /module boundaries/i, /helper patterns/i],
        action: 'Align the change with local project style, naming, boundaries, and helper patterns.'
    }),
    Object.freeze({
        id: 'unnecessary_abstraction',
        promptPatterns: [/abstractions/i, /duplication/i, /complexity/i],
        action: 'Remove abstractions that do not reduce real duplication, risk, or complexity.'
    }),
    Object.freeze({
        id: 'size_growth',
        promptPatterns: [/classes, functions, or files/i, /grew/i, /ownership/i],
        action: 'Extract or clarify touched code that grew enough to blur ownership.'
    }),
    Object.freeze({
        id: 'hardcoded_values_contracts',
        promptPatterns: [/literals, paths, statuses, or messages/i, /constants/i, /contracts/i],
        action: 'Move new literals, paths, statuses, or messages into shared contracts where appropriate.'
    }),
    Object.freeze({
        id: 'duplicated_logic_contracts',
        promptPatterns: [/duplicates logic/i, /validation/i, /one place/i],
        action: 'Remove duplicated logic, validation, or contract strings.'
    }),
    Object.freeze({
        id: 'test_verification_scope',
        promptPatterns: [/focused tests/i, /behavioral risk/i, /slow coverage/i],
        action: 'Adjust verification scope so behavioral risk is covered without unrelated slow tests.'
    })
]);

const UNIVERSAL_QUALITY_RULE_IDS = Object.freeze(
    UNIVERSAL_QUALITY_RULE_EXPECTATIONS.map((rule) => rule.id)
);

function stringSha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function answersTemplatePolicySha256(
    activeRuleIds: readonly string[],
    activeRuleFingerprints: Record<string, string>
): string {
    return stringSha256(JSON.stringify({
        schema_version: 1,
        active_rule_ids: activeRuleIds,
        active_rule_fingerprints: activeRuleIds.map((ruleId) => [
            ruleId,
            String(activeRuleFingerprints[ruleId] || '').trim().toLowerCase()
        ])
    }));
}

const OPS_SHELL_QUALITY_RULE_EXPECTATIONS = Object.freeze([
    Object.freeze({
        id: 'ops_shell_strict_error_handling',
        promptPatterns: [/strict shell behavior/i, /error propagation/i, /portability/i],
        action: 'Tighten strict shell behavior, error propagation, cleanup paths, and portability.'
    }),
    Object.freeze({
        id: 'ops_deploy_backup_idempotency',
        promptPatterns: [/idempotency/i, /dry-run or confirmation/i, /restore verification/i],
        action: 'Add idempotency, dry-run or confirmation semantics, and restore verification where needed.'
    }),
    Object.freeze({
        id: 'ops_secret_env_loading',
        promptPatterns: [/secret handling/i, /env-file loading safety/i, /shared helper/i],
        action: 'Reuse or extract shared environment-loading helpers and keep secrets out of logs.'
    })
]);

const OPS_SHELL_QUALITY_RULE_IDS = Object.freeze(
    OPS_SHELL_QUALITY_RULE_EXPECTATIONS.map((rule) => rule.id)
);
const OPS_SHELL_QUALITY_RULE_ID_SET = new Set<string>(OPS_SHELL_QUALITY_RULE_IDS);

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

function buildTestQualityRule(id: string): ReturnType<typeof buildDefaultWorkflowConfig>['optional_quality_checks']['rules'][number] {
    return {
        id,
        title: `Rule ${id}`,
        prompt: `Check ${id}.`,
        enabled: true
    };
}

function writeStaleMovedRuleWorkflowConfig(fixture: ReturnType<typeof createGateFixture>): void {
    const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
    const config = buildDefaultWorkflowConfig();
    config.optional_quality_checks.baseline_version = '2026-06-26.t843';
    config.optional_quality_checks.rules = [
        ...config.optional_quality_checks.rules,
        ...MOVED_PROJECT_LOCAL_RULE_IDS.map(buildTestQualityRule),
        ...CUSTOM_GARDA_RULE_IDS.map(buildTestQualityRule)
    ];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function buildPassAnswers(): Array<Record<string, unknown>> {
    return buildPassAnswersForRuleIds(UNIVERSAL_QUALITY_RULE_IDS);
}

function buildPassAnswersForRuleIds(ruleIds: readonly string[]): Array<Record<string, unknown>> {
    return ruleIds.map((ruleId) => ({
        rule_id: ruleId,
        status: 'PASS',
        answer: `Checked ${ruleId} against the changed files.`,
        evidence_files: ['src/app.ts'],
        actions_taken: [`No action required for ${ruleId}.`]
    }));
}

function buildTrustBoundaryAnswer(): Record<string, unknown> {
    const scenario = 'rejects stale trust-boundary evidence';
    return {
        rule_id: TRUST_BOUNDARY_ANALYSIS_RULE_ID,
        status: 'PASS',
        answer: 'Mapped mutable reviewer output into the gate-owned authenticated receipt boundary.',
        evidence_files: ['tests/node/gates/quality-checklist/quality-checklist.test.ts'],
        trust_boundary_matrix: [{
            boundary_id: 'TB-001',
            boundary: 'Mutable reviewer output to authenticated receipt',
            authority_source: 'Gate-owned launch input and receipt bindings',
            mutable_inputs: ['provider reviewer output'],
            integrity_evidence: ['launch input sha256', 'review context sha256', 'tree state sha256'],
            canonical_reconstruction: 'Rebuild the receipt from immutable launch input plus normalized findings.',
            toctou_replay: 'Reject output from before delegation start or from a superseded review cycle.',
            negative_paths: [{
                kind: 'stale',
                scenario,
                expected_behavior: 'Reject the output without materializing accepted review state.',
                evidence_files: [
                    `tests/node/gates/quality-checklist/quality-checklist.test.ts#${scenario}`
                ]
            }]
        }]
    };
}

function buildGenericActionRequiredAnswers(): Array<Record<string, unknown>> {
    const actionByRuleId = new Map<string, string>(
        UNIVERSAL_QUALITY_RULE_EXPECTATIONS.map((rule) => [rule.id, rule.action])
    );
    return buildPassAnswers().map((answer) => {
        const action = actionByRuleId.get(String(answer.rule_id));
        if (!action) {
            return answer;
        }
        return {
            ...answer,
            status: 'ACTION_REQUIRED',
            answer: `The ${answer.rule_id} check found a review-saving regression risk before expensive gates.`,
            evidence_files: [
                'src/gates/next-step/next-step-task-queue.ts',
                'tests/node/gates/next-step/next-step-task-queue.test.ts'
            ],
            actions_taken: [],
            actions_required: [action]
        };
    });
}

describe('quality-checklist gate', () => {
    it('keeps declared source and absent execution pending without semantic completion', () => {
        const f = declaredQualityFixture();
        try {
            const artifact = f.artifact(), phases = declaredPhases(artifact);
            assert.equal(artifact.status, 'PENDING_VALIDATION');
            assert.deepEqual([phases?.structural, phases?.execution, phases?.semantic], ['BOUND', 'PENDING', 'PENDING_INDEPENDENT_REVIEW']);
            assert.equal(phases?.obligations.length, 1);
            assert.equal(phases?.obligations[0].source_identity.path, 'RootSuite');
            assert.equal(phases?.obligations[0].target_id, 'opaque-1');
            assert.equal(phases?.obligations[0].source_identity.sha256, createHash('sha256').update(fs.readFileSync(path.join(f.repoRoot, 'RootSuite'))).digest('hex'));
        } finally { f.cleanup(); }
    });

    it('records genuine execution observations while preserving failed and unknown result semantics', async () => {
        const states: Array<[string | undefined, string | undefined, string | null | undefined]> = [];
        for (const mode of ['passed', 'failed', 'opaque']) {
            const f = declaredQualityFixture(mode);
            try {
                await f.execute(); const phases = declaredPhases(f.artifact());
                states.push([phases?.execution, phases?.semantic, phases?.obligations[0].result_status]);
            } finally { f.cleanup(); }
        }
        assert.deepEqual(states, [['OBSERVED', 'PENDING_INDEPENDENT_REVIEW', 'PASSED'],
            ['REJECTED', 'PENDING_INDEPENDENT_REVIEW', 'FAILED'], ['OBSERVED', 'PENDING_INDEPENDENT_REVIEW', 'UNRESOLVED']]);
    });

    it('rejects tampered stale and superseded validation facts instead of closing semantic obligations', async () => {
        const f = declaredQualityFixture();
        try {
            const result = await f.execute(), file = path.join(f.repoRoot, result.result_path), original = fs.readFileSync(file);
            const sourceFile = path.join(f.repoRoot, 'RootSuite'), originalSource = fs.readFileSync(sourceFile);
            const current = declaredPhases(f.artifact());
            fs.appendFileSync(file, ' '); const tampered = declaredPhases(f.artifact()); fs.writeFileSync(file, original);
            fs.appendFileSync(sourceFile, '\nchanged after validation\n');
            const stale = f.artifact();
            fs.writeFileSync(sourceFile, originalSource);
            await f.execute(AbortSignal.abort()); const superseded = declaredPhases(f.artifact());
            assert.deepEqual([current?.execution, tampered?.execution, superseded?.execution],
                ['OBSERVED', 'REJECTED', 'REJECTED']);
            assert.equal(stale.status, 'CONFIG_ERROR');
            assert.equal(declaredPhases(stale), undefined);
            assert.ok(stale.violations.some(violation => violation.startsWith('Project validation quality rejected:')));
            assert.equal(current?.obligations[0].id, tampered?.obligations[0].id);
            assert.notEqual(current?.sha256, tampered?.sha256);
            assert.equal(superseded?.semantic, 'PENDING_INDEPENDENT_REVIEW');
        } finally { f.cleanup(); }
    });

    it('rejects delayed evaluation of an earlier success after a newer cancelled attempt', async () => {
        const f = declaredQualityFixture();
        try {
            const earlier = await executeValidationRecipe({ repoRoot: f.repoRoot, taskId: f.taskId, recipeId: 'neutral' });
            await f.execute(AbortSignal.abort());
            const cancelled = declaredPhases(f.artifact());
            await evaluateValidationAttempt({ repoRoot: f.repoRoot, taskId: f.taskId, attemptId: earlier.attempt_id });
            const delayed = declaredPhases(f.artifact());
            assert.deepEqual([cancelled?.execution, delayed?.execution], ['REJECTED', 'REJECTED']);
            assert.equal(delayed?.sha256, cancelled?.sha256);
            assert.equal(delayed?.semantic, 'PENDING_INDEPENDENT_REVIEW');
        } finally { f.cleanup(); }
    });

    it('retains targetless recipe execution and rejects a failed compile beside observed tests', async () => {
        const states: Array<[string | undefined, string | undefined]> = [];
        for (const mode of ['passed', 'failed']) {
            const f = declaredQualityFixture('passed', mode);
            try {
                await f.execute(); const pending = declaredPhases(f.artifact());
                await f.execute(undefined, 'compile'); const completed = declaredPhases(f.artifact());
                states.push([pending?.execution, completed?.execution]);
                assert.notEqual(pending?.sha256, completed?.sha256);
                const compile = completed?.executions.find(recipe => recipe.recipe_id === 'compile');
                assert.ok(compile?.attempt_id);
                assert.match(compile?.result_sha256 ?? '', /^[a-f0-9]{64}$/u);
                assert.equal(completed?.semantic, 'PENDING_INDEPENDENT_REVIEW');
            } finally { f.cleanup(); }
        }
        assert.deepEqual(states, [['PENDING', 'OBSERVED'], ['PENDING', 'REJECTED']]);
    });
    it('ships enabled universal baseline prompts and excludes project-local rule classes', () => {
        const rulesById = new Map(DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => [rule.id, rule]));

        for (const expectation of UNIVERSAL_QUALITY_RULE_EXPECTATIONS) {
            const rule = rulesById.get(expectation.id);
            assert.ok(rule, `Expected shipped optional quality rule '${expectation.id}'.`);
            assert.equal(rule.enabled, true);
            const searchableText = `${rule.title}\n${rule.prompt}`;
            for (const pattern of expectation.promptPatterns) {
                assert.match(searchableText, pattern, `Rule '${expectation.id}' should mention ${pattern}.`);
            }
        }
        const testOnlySkippedRuleIds = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES
            .filter((rule) => isOptionalQualityCheckRuleExcludedForScope(rule, 'test-only'))
            .map((rule) => rule.id)
            .sort();
        assert.deepEqual(testOnlySkippedRuleIds, [
            'code_simplification',
            'size_growth',
            'unnecessary_abstraction'
        ]);

        for (const ruleId of MOVED_PROJECT_LOCAL_RULE_IDS) {
            assert.equal(rulesById.has(ruleId), false, `Expected '${ruleId}' to be project-local, not shipped baseline.`);
        }
    });

    it('ships ops/shell baseline prompts as changed-file scoped rules', () => {
        const rulesById = new Map(DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => [rule.id, rule]));

        assert.deepEqual(
            OPS_SHELL_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id),
            OPS_SHELL_QUALITY_RULE_IDS
        );
        for (const expectation of OPS_SHELL_QUALITY_RULE_EXPECTATIONS) {
            const rule = rulesById.get(expectation.id);
            assert.ok(rule, `Expected shipped optional quality rule '${expectation.id}'.`);
            assert.equal(rule.enabled, true);
            assert.ok(
                Array.isArray(rule.included_changed_file_regexes) && rule.included_changed_file_regexes.length > 0,
                `Rule '${expectation.id}' should be active only for matching ops/shell changed files.`
            );
            assert.equal(rule.excluded_scope_categories, undefined);
            const searchableText = `${rule.title}\n${rule.prompt}`;
            for (const pattern of expectation.promptPatterns) {
                assert.match(searchableText, pattern, `Rule '${expectation.id}' should mention ${pattern}.`);
            }
        }
    });

    it('builds PASS artifact with configured rules and changed-file evidence', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-pass' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                metrics: {
                    changed_lines_total: 4,
                    scope_sha256: 'a'.repeat(64),
                    scope_content_sha256: 'b'.repeat(64)
                },
                changed_files: ['src/app.ts', 'src/feature.ts']
            });

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswers()
            });

            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.outcome, 'PASS');
            assert.equal(artifact.checklist_id, 'optional_quality_checks');
            assert.equal(artifact.rules.length, DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length);
            assert.equal(artifact.answers.length, UNIVERSAL_QUALITY_RULE_IDS.length);
            assert.deepEqual(artifact.changed_file_evidence.changed_files, ['src/app.ts', 'src/feature.ts']);
            assert.equal(artifact.changed_file_evidence.scope_sha256, 'a'.repeat(64));
            assert.equal(artifact.changed_file_evidence.scope_content_sha256, 'b'.repeat(64));
            assert.equal(artifact.enabled_rule_count, DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length);
            assert.equal(artifact.active_rule_count, UNIVERSAL_QUALITY_RULE_IDS.length);
            assert.equal(artifact.skipped_by_scope_rule_count, OPS_SHELL_QUALITY_RULE_IDS.length + 1);
            assert.ok(artifact.workflow_config_sha256);
            assert.ok(artifact.preflight_sha256);
            assert.deepEqual(artifact.violations, []);
            assert.deepEqual(
                artifact.rules
                    .filter((rule) => rule.scope_applicability === 'skipped_by_scope')
                    .map((rule) => rule.id)
                    .sort(),
                [...OPS_SHELL_QUALITY_RULE_IDS, TRUST_BOUNDARY_ANALYSIS_RULE_ID].sort()
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('blocks cadence skip evidence when current configuration has non-answer violations', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-cadence-skip-config-error' });
        try {
            const workflowConfigPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'live',
                'config',
                'workflow-config.json'
            );
            const workflowConfig = buildDefaultWorkflowConfig();
            workflowConfig.optional_quality_checks.rules = [
                ...workflowConfig.optional_quality_checks.rules,
                {
                    ...workflowConfig.optional_quality_checks.rules[0],
                    title: 'Duplicate rule for regression'
                }
            ];
            fs.writeFileSync(workflowConfigPath, `${JSON.stringify(workflowConfig, null, 2)}\n`, 'utf8');
            const preflightPath = writeGateFixturePreflight(fixture);

            const artifact = buildQualityChecklistCadenceSkipArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.equal(artifact.outcome, 'FAIL');
            assert.deepEqual(artifact.answers, []);
            assert.ok(artifact.violations.some((violation) => violation.includes('duplicate quality-check rule id')));
            assert.equal(
                artifact.violations.some((violation) => violation.startsWith('Missing answer for active quality-check rule')),
                false
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('fails closed when review-failure cadence interval configuration is invalid', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-invalid-cadence-interval' });
        try {
            const workflowConfigPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'live',
                'config',
                'workflow-config.json'
            );
            const workflowConfig = buildDefaultWorkflowConfig();
            workflowConfig.optional_quality_checks.review_failure_cadence_interval = 0;
            fs.writeFileSync(workflowConfigPath, `${JSON.stringify(workflowConfig, null, 2)}\n`, 'utf8');
            const preflightPath = writeGateFixturePreflight(fixture);

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswers()
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => (
                violation.includes('workflow-config.optional_quality_checks.review_failure_cadence_interval must be an integer from 1 to 100')
            )));

            const workflowConfigWithStringCadence = buildDefaultWorkflowConfig();
            (workflowConfigWithStringCadence.optional_quality_checks as unknown as Record<string, unknown>)
                .review_failure_cadence_interval = '3';
            fs.writeFileSync(workflowConfigPath, `${JSON.stringify(workflowConfigWithStringCadence, null, 2)}\n`, 'utf8');

            const stringCadenceArtifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswers()
            });

            assert.equal(stringCadenceArtifact.status, 'CONFIG_ERROR');
            assert.equal(stringCadenceArtifact.outcome, 'FAIL');
            assert.ok(stringCadenceArtifact.violations.some((violation) => (
                violation.includes('workflow-config.optional_quality_checks.review_failure_cadence_interval must be an integer from 1 to 100')
            )));
        } finally {
            fixture.cleanup();
        }
    });

    it('activates ops/shell rules for shell, deploy, backup, and restore changed files', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-ops-shell-active-rules' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                scope_category: 'config-only',
                metrics: {
                    changed_lines_total: 12,
                    scope_sha256: 'e'.repeat(64),
                    scope_content_sha256: 'f'.repeat(64)
                },
                changed_files: [
                    'scripts/deploy.sh',
                    'ops/backup.ps1',
                    '.github/workflows/restore-release.yml'
                ]
            });
            const expectedActiveRuleIds = [
                ...UNIVERSAL_QUALITY_RULE_IDS,
                ...OPS_SHELL_QUALITY_RULE_IDS
            ];

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswersForRuleIds(expectedActiveRuleIds)
            });

            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.scope_category, 'config-only');
            assert.equal(artifact.enabled_rule_count, DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length);
            assert.equal(artifact.active_rule_count, expectedActiveRuleIds.length);
            assert.equal(artifact.skipped_by_scope_rule_count, 1);
            assert.deepEqual(
                artifact.rules
                    .filter((rule) => OPS_SHELL_QUALITY_RULE_ID_SET.has(rule.id))
                    .map((rule) => [rule.id, rule.scope_applicability]),
                OPS_SHELL_QUALITY_RULE_IDS.map((ruleId) => [ruleId, 'active'])
            );
            assert.deepEqual(artifact.violations, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('activates ops/shell rules for non-shell ops script extensions', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-ops-script-extension-rules' });
        try {
            const expectedActiveRuleIds = [
                ...UNIVERSAL_QUALITY_RULE_IDS,
                ...OPS_SHELL_QUALITY_RULE_IDS
            ];
            const changedFiles = [
                'scripts/deploy-release.mjs',
                'tools/backup-runner.ts',
                'ops/restore_snapshot.py'
            ];

            for (const changedFile of changedFiles) {
                const preflightPath = writeGateFixturePreflight(fixture, {
                    scope_category: 'mixed',
                    metrics: {
                        changed_lines_total: 8,
                        scope_sha256: '1'.repeat(64),
                        scope_content_sha256: '2'.repeat(64)
                    },
                    changed_files: [changedFile]
                });

                const artifact = buildQualityChecklistArtifact({
                    repoRoot: fixture.repoRoot,
                    taskId: fixture.taskId,
                    preflightPath,
                    answers: buildPassAnswersForRuleIds(expectedActiveRuleIds)
                });

                assert.equal(artifact.status, 'PASS', changedFile);
                assert.equal(artifact.active_rule_count, expectedActiveRuleIds.length, changedFile);
                assert.equal(artifact.skipped_by_scope_rule_count, 1, changedFile);
                assert.deepEqual(
                    artifact.rules
                        .filter((rule) => OPS_SHELL_QUALITY_RULE_ID_SET.has(rule.id))
                        .map((rule) => [rule.id, rule.scope_applicability]),
                    OPS_SHELL_QUALITY_RULE_IDS.map((ruleId) => [ruleId, 'active']),
                    changedFile
                );
                assert.deepEqual(artifact.violations, [], changedFile);
            }
        } finally {
            fixture.cleanup();
        }
    });

    it('does not activate ops/shell rules for ordinary filenames containing ops as a substring', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-ops-substring-not-active' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                scope_category: 'mixed',
                metrics: {
                    changed_lines_total: 6,
                    scope_sha256: '3'.repeat(64),
                    scope_content_sha256: '4'.repeat(64)
                },
                changed_files: ['src/components/props.ts']
            });

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswersForRuleIds(UNIVERSAL_QUALITY_RULE_IDS)
            });

            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.active_rule_count, UNIVERSAL_QUALITY_RULE_IDS.length);
            assert.equal(artifact.skipped_by_scope_rule_count, OPS_SHELL_QUALITY_RULE_IDS.length + 1);
            assert.deepEqual(
                artifact.rules
                    .filter((rule) => OPS_SHELL_QUALITY_RULE_ID_SET.has(rule.id))
                    .map((rule) => [rule.id, rule.scope_applicability]),
                OPS_SHELL_QUALITY_RULE_IDS.map((ruleId) => [ruleId, 'skipped_by_scope'])
            );
            assert.deepEqual(artifact.violations, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('accepts only active rule answers for test-only scope and records skipped rules', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-test-only-active-rules' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                scope_category: 'test-only',
                metrics: {
                    changed_lines_total: 4,
                    scope_sha256: 'a'.repeat(64),
                    scope_content_sha256: 'b'.repeat(64)
                },
                changed_files: ['tests/node/gates/quality-checklist/quality-checklist.test.ts']
            });
            const activeRuleIds = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES
                .filter((rule) => isOptionalQualityCheckRuleActiveForScope(
                    rule,
                    'test-only',
                    ['tests/node/gates/quality-checklist/quality-checklist.test.ts']
                ))
                .map((rule) => rule.id);

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswersForRuleIds(activeRuleIds)
            });

            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.scope_category, 'test-only');
            assert.equal(artifact.enabled_rule_count, DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.length);
            assert.equal(artifact.active_rule_count, activeRuleIds.length);
            assert.equal(artifact.skipped_by_scope_rule_count, 4 + OPS_SHELL_QUALITY_RULE_IDS.length);
            assert.equal(artifact.answers.length, activeRuleIds.length);
            assert.deepEqual(
                artifact.rules
                    .filter((rule) => rule.scope_applicability === 'skipped_by_scope')
                    .map((rule) => rule.id)
                    .sort(),
                [
                    'code_simplification',
                    ...OPS_SHELL_QUALITY_RULE_IDS,
                    'size_growth',
                    TRUST_BOUNDARY_ANALYSIS_RULE_ID,
                    'unnecessary_abstraction'
                ].sort()
            );
            assert.deepEqual(artifact.violations, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects answers for rules skipped by test-only scope', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-test-only-skipped-answer' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                scope_category: 'test-only',
                changed_files: ['tests/node/gates/quality-checklist/quality-checklist.test.ts']
            });
            const activeRuleIds = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES
                .filter((rule) => !isOptionalQualityCheckRuleExcludedForScope(rule, 'test-only'))
                .filter((rule) => !OPS_SHELL_QUALITY_RULE_ID_SET.has(rule.id))
                .map((rule) => rule.id);
            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: [
                    ...buildPassAnswersForRuleIds(activeRuleIds),
                    {
                        rule_id: 'code_simplification',
                        status: 'PASS',
                        answer: 'This rule is intentionally skipped for pure test changes.'
                    }
                ]
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.ok(artifact.violations.some((violation) => (
                violation.includes("Answer references quality-check rule 'code_simplification' skipped for the current preflight scope")
            )));
        } finally {
            fixture.cleanup();
        }
    });

    it('applies custom rule test-only opt-out through quality-checklist behavior', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-custom-test-only-skip' });
        try {
            const customRule = {
                ...buildTestQualityRule('custom_test_only_skip'),
                excluded_scope_categories: ['test-only']
            };
            const config = buildDefaultWorkflowConfig();
            config.optional_quality_checks.rules = [
                ...config.optional_quality_checks.rules,
                customRule
            ];
            fs.writeFileSync(
                path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json'),
                JSON.stringify(config, null, 2) + '\n',
                'utf8'
            );
            const preflightPath = writeGateFixturePreflight(fixture, {
                scope_category: 'test-only',
                changed_files: ['tests/node/gates/quality-checklist/quality-checklist.test.ts']
            });
            const activeRuleIds = config.optional_quality_checks.rules
                .filter((rule) => isOptionalQualityCheckRuleActiveForScope(
                    rule,
                    'test-only',
                    ['tests/node/gates/quality-checklist/quality-checklist.test.ts']
                ))
                .map((rule) => rule.id);

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswersForRuleIds(activeRuleIds)
            });
            const skippedCustomRule = artifact.rules.find((rule) => rule.id === customRule.id);

            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.scope_category, 'test-only');
            assert.equal(artifact.enabled_rule_count, config.optional_quality_checks.rules.length);
            assert.equal(artifact.active_rule_count, activeRuleIds.length);
            assert.equal(artifact.skipped_by_scope_rule_count, 5 + OPS_SHELL_QUALITY_RULE_IDS.length);
            assert.equal(skippedCustomRule?.scope_applicability, 'skipped_by_scope');
            assert.deepEqual(skippedCustomRule?.excluded_scope_categories, ['test-only']);
            assert.match(skippedCustomRule?.scope_skip_reason || '', /test-only/u);
            assert.equal(artifact.answers.some((answer) => answer.rule_id === customRule.id), false);
            assert.deepEqual(artifact.violations, []);

            const rejectedArtifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: [
                    ...buildPassAnswersForRuleIds(activeRuleIds),
                    {
                        rule_id: customRule.id,
                        status: 'PASS',
                        answer: 'This custom rule is intentionally skipped for pure test changes.'
                    }
                ]
            });

            assert.equal(rejectedArtifact.status, 'CONFIG_ERROR');
            assert.ok(rejectedArtifact.violations.some((violation) => (
                violation.includes("Answer references quality-check rule 'custom_test_only_skip' skipped for the current preflight scope")
            )));
        } finally {
            fixture.cleanup();
        }
    });

    it('records ACTION_REQUIRED for every universal baseline rule before review setup', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-derived-actions' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                metrics: {
                    changed_lines_total: 42,
                    scope_sha256: 'c'.repeat(64),
                    scope_content_sha256: 'd'.repeat(64)
                },
                changed_files: [
                    'src/gates/next-step/task-queue.ts',
                    'src/gates/next-step/pre-routing.ts',
                    'src/gates/cycle/cycle-guard.ts',
                    'tests/node/gates/next-step/next-step-task-queue.test.ts',
                    'tests/node/gates/next-step/next-step-quality-checklist-routing.test.ts',
                    'tests/node/gates/review-cycle/review-cycle-guard.test.ts'
                ]
            });

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(buildGenericActionRequiredAnswers()),
                emitMetrics: false
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_ACTION_REQUIRED'));
            assert.ok(result.outputLines.includes(`ActionsRequiredCount: ${UNIVERSAL_QUALITY_RULE_EXPECTATIONS.length}`));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            const requiredRuleIds = artifact.answers
                .filter((answer: { status: string }) => answer.status === 'ACTION_REQUIRED')
                .map((answer: { rule_id: string }) => answer.rule_id)
                .sort();

            assert.equal(artifact.status, 'ACTION_REQUIRED');
            assert.deepEqual(
                requiredRuleIds,
                UNIVERSAL_QUALITY_RULE_EXPECTATIONS.map((rule) => rule.id).sort()
            );
            assert.equal(artifact.actions_required.length, UNIVERSAL_QUALITY_RULE_EXPECTATIONS.length);
            assert.ok(artifact.changed_file_evidence.changed_files.some((filePath: string) => filePath.startsWith('tests/')));
        } finally {
            fixture.cleanup();
        }
    });

    it('records ACTION_REQUIRED output and returns gate failure', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-action' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answers = buildPassAnswers();
            answers[0] = {
                ...answers[0],
                status: 'ACTION_REQUIRED',
                answer: 'The change needs a smaller helper before closeout.',
                actions_required: ['Extract repeated status formatting before completion.']
            };

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(answers),
                emitMetrics: false
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_ACTION_REQUIRED'));
            assert.ok(result.outputLines.includes('ActionsRequiredCount: 1'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifactPath = artifactPathLine.replace('QualityChecklistArtifactPath: ', '');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'ACTION_REQUIRED');
            assert.deepEqual(artifact.actions_required, ['Extract repeated status formatting before completion.']);

            const timelinePath = path.join(fixture.orchestratorRoot, 'runtime', 'task-events', `${fixture.taskId}.jsonl`);
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.ok(timeline.includes('"event_type":"QUALITY_CHECKLIST_RECORDED"'));
            assert.ok(timeline.includes('"artifact_hash"'));
        } finally {
            fixture.cleanup();
        }
    });

    it('promotes top-level actions_required to ACTION_REQUIRED', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-top-level-action' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(buildPassAnswers()),
                actionRequired: 'Document the remaining follow-up before closeout.',
                emitMetrics: false
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_ACTION_REQUIRED'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            assert.equal(artifact.status, 'ACTION_REQUIRED');
            assert.equal(artifact.outcome, 'FAIL');
            assert.deepEqual(artifact.actions_required, ['Document the remaining follow-up before closeout.']);
        } finally {
            fixture.cleanup();
        }
    });

    it('records WARN output and returns gate success', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-warn' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answers = buildPassAnswers();
            answers[0] = {
                ...answers[0],
                status: 'WARN',
                answer: 'The change is acceptable, but follow-up simplification may be useful.'
            };

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(answers),
                emitMetrics: false
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_WARNED'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            assert.equal(artifact.status, 'WARN');
            assert.equal(artifact.outcome, 'WARN');
        } finally {
            fixture.cleanup();
        }
    });

    it('reads answers from a repo-local JSON file', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-answers-path' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'quality-answers.json');
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, JSON.stringify(buildPassAnswers()), 'utf8');

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath,
                emitMetrics: false
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_PASSED'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            assert.equal(artifact.status, 'PASS');
            assert.equal(artifact.answers.length, UNIVERSAL_QUALITY_RULE_IDS.length);
        } finally {
            fixture.cleanup();
        }
    });

    it('materializes a bound answers template without fabricating checklist answers', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-answers-template' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );

            const materialized = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });

            assert.equal(materialized.status, 'created');
            const template = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
                event_source: string;
                task_id: string;
                preflight_sha256: string;
                effective_policy_sha256: string;
                active_rule_ids: string[];
                active_rule_fingerprints: Record<string, string>;
                answers: Array<Record<string, unknown>>;
            };
            assert.equal(template.event_source, 'quality-checklist-answers-template');
            assert.equal(template.task_id, fixture.taskId);
            assert.match(template.preflight_sha256, /^[a-f0-9]{64}$/u);
            assert.match(template.effective_policy_sha256, /^[a-f0-9]{64}$/u);
            assert.equal(template.answers.length, UNIVERSAL_QUALITY_RULE_IDS.length);
            assert.deepEqual(template.active_rule_ids, UNIVERSAL_QUALITY_RULE_IDS);
            assert.deepEqual(Object.keys(template.active_rule_fingerprints).sort(), [...UNIVERSAL_QUALITY_RULE_IDS].sort());
            assert.ok(Object.values(template.active_rule_fingerprints).every((fingerprint) => /^[a-f0-9]{64}$/u.test(fingerprint)));
            assert.ok(template.answers.every((answer) => answer.status === '' && answer.answer === ''));
            assert.ok(template.answers.every((answer) => (
                Object.keys(answer).sort().join(',') === 'answer,rule_id,status'
                && !Object.hasOwn(answer, 'title')
                && !Object.hasOwn(answer, 'prompt')
            )));

            template.answers = template.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Checked ${String(answer.rule_id)} against the changed files.`
            }));
            fs.writeFileSync(answersPath, JSON.stringify(template, null, 2) + '\n', 'utf8');

            const checklistResult = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath,
                emitMetrics: false
            });
            assert.equal(checklistResult.exitCode, 0);
            assert.ok(checklistResult.outputLines.includes('QUALITY_CHECKLIST_PASSED'));
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects a failed atomic template replacement without advancing binding or event authority', (context) => {
        const fixture = createGateFixture({ taskId: 'T-quality-atomic-template-failure' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const options = { repoRoot: fixture.repoRoot, taskId: fixture.taskId, preflightPath };
            const initial = materializeQualityChecklistAnswersTemplate(options);
            const answersPath = initial.answers_path;
            initial.template.answers[0].status = 'PASS';
            initial.template.answers[0].answer = 'Retain this authenticated rule answer after recovery.';
            fs.writeFileSync(answersPath, JSON.stringify(initial.template, null, 2) + '\n', 'utf8');
            const original = fs.readFileSync(answersPath, 'utf8');
            const bindingPath = `${answersPath}.binding.json`;
            const originalBinding = fs.readFileSync(bindingPath, 'utf8');
            const timelinePath = path.join(fixture.orchestratorRoot, 'runtime', 'task-events', `${fixture.taskId}.jsonl`);
            const originalTimeline = fs.readFileSync(timelinePath, 'utf8');
            const originalDirectory = fs.readdirSync(path.dirname(answersPath)).sort();
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            preflight.changed_files = ['src/app.ts', 'src/refreshed.ts'];
            fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2) + '\n', 'utf8');
            const filesystem = require('node:fs') as typeof fs;
            const rename = filesystem.renameSync;
            const failedReplace = context.mock.method(filesystem, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
                if (path.resolve(String(to)) === path.resolve(answersPath)) {
                    throw Object.assign(new Error('Injected template publication failure'), { code: 'EIO' });
                }
                rename(from, to);
            });

            assert.throws(() => materializeQualityChecklistAnswersTemplate(options), /template publication failure/u);
            assert.equal(fs.readFileSync(answersPath, 'utf8'), original);
            assert.equal(fs.readFileSync(bindingPath, 'utf8'), originalBinding);
            assert.equal(fs.readFileSync(timelinePath, 'utf8'), originalTimeline);
            assert.deepEqual(fs.readdirSync(path.dirname(answersPath)).sort(), originalDirectory);

            failedReplace.mock.restore();
            const recovered = materializeQualityChecklistAnswersTemplate(options);
            assert.equal(recovered.status, 'refreshed');
            assert.equal(recovered.template.answers[0].answer, initial.template.answers[0].answer);
            const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8')) as { preflight_sha256: string };
            assert.equal(binding.preflight_sha256, recovered.template.preflight_sha256);
        } finally {
            context.mock.restoreAll();
            fixture.cleanup();
        }
    });

    it('rejects stale answer reuse after an atomic binding replacement fails', (context) => {
        const fixture = createGateFixture({ taskId: 'T-quality-atomic-binding-failure' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const options = { repoRoot: fixture.repoRoot, taskId: fixture.taskId, preflightPath };
            const initial = materializeQualityChecklistAnswersTemplate(options);
            const answersPath = initial.answers_path;
            initial.template.answers[0].status = 'PASS';
            initial.template.answers[0].answer = 'Do not reuse without matching authenticated binding.';
            fs.writeFileSync(answersPath, JSON.stringify(initial.template, null, 2) + '\n', 'utf8');
            const bindingPath = `${answersPath}.binding.json`;
            const originalBinding = fs.readFileSync(bindingPath, 'utf8');
            const timelinePath = path.join(fixture.orchestratorRoot, 'runtime', 'task-events', `${fixture.taskId}.jsonl`);
            const originalTimeline = fs.readFileSync(timelinePath, 'utf8');
            const originalDirectory = fs.readdirSync(path.dirname(answersPath)).sort();
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            preflight.changed_files = ['src/app.ts', 'src/first-refresh.ts'];
            fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2) + '\n', 'utf8');
            const filesystem = require('node:fs') as typeof fs;
            const rename = filesystem.renameSync;
            const failedReplace = context.mock.method(filesystem, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
                if (path.resolve(String(to)) === path.resolve(bindingPath)) {
                    throw Object.assign(new Error('Injected binding publication failure'), { code: 'EIO' });
                }
                rename(from, to);
            });

            assert.throws(() => materializeQualityChecklistAnswersTemplate(options), /binding publication failure/u);
            assert.equal(fs.readFileSync(bindingPath, 'utf8'), originalBinding);
            assert.equal(fs.readFileSync(timelinePath, 'utf8'), originalTimeline);
            assert.deepEqual(fs.readdirSync(path.dirname(answersPath)).sort(), originalDirectory);
            const unboundBytes = fs.readFileSync(answersPath, 'utf8');
            const unboundTemplate = JSON.parse(unboundBytes) as { preflight_sha256: string };
            assert.notEqual(unboundTemplate.preflight_sha256, initial.template.preflight_sha256);

            failedReplace.mock.restore();
            preflight.changed_files = ['src/app.ts', 'src/second-refresh.ts'];
            fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2) + '\n', 'utf8');
            const repaired = materializeQualityChecklistAnswersTemplate(options);
            assert.equal(repaired.status, 'repair_created');
            assert.equal(repaired.original_answers_path, answersPath);
            assert.equal(fs.readFileSync(answersPath, 'utf8'), unboundBytes);
            assert.equal(fs.readFileSync(bindingPath, 'utf8'), originalBinding);
            assert.ok(repaired.template.answers.every((answer) => answer.status === '' && answer.answer === ''));
        } finally {
            context.mock.restoreAll();
            fixture.cleanup();
        }
    });

    it('rejects stale answer reuse when matching binding event evidence is missing', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-missing-binding-event' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const options = { repoRoot: fixture.repoRoot, taskId: fixture.taskId, preflightPath };
            const initial = materializeQualityChecklistAnswersTemplate(options);
            const answersPath = initial.answers_path;
            initial.template.answers[0].status = 'PASS';
            initial.template.answers[0].answer = 'Untrusted without the native task-event binding.';
            fs.writeFileSync(answersPath, JSON.stringify(initial.template, null, 2) + '\n', 'utf8');
            const original = fs.readFileSync(answersPath, 'utf8');
            const bindingPath = `${answersPath}.binding.json`;
            const originalBinding = fs.readFileSync(bindingPath, 'utf8');
            const timelinePath = path.join(fixture.orchestratorRoot, 'runtime', 'task-events', `${fixture.taskId}.jsonl`);
            fs.renameSync(timelinePath, `${timelinePath}.preserved`);
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            preflight.changed_files = ['src/app.ts', 'src/after-missing-event.ts'];
            fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2) + '\n', 'utf8');

            const repaired = materializeQualityChecklistAnswersTemplate(options);
            assert.equal(repaired.status, 'repair_created');
            assert.equal(repaired.original_answers_path, answersPath);
            assert.equal(fs.readFileSync(answersPath, 'utf8'), original);
            assert.equal(fs.readFileSync(bindingPath, 'utf8'), originalBinding);
            assert.ok(repaired.template.answers.every((answer) => answer.status === '' && answer.answer === ''));
        } finally {
            fixture.cleanup();
        }
    });

    it('preserves filled repair answers across repeated materialization and coherent preflight refresh', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-repair-restart-preservation' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.orchestratorRoot,
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, '{unsafe canonical json', 'utf8');

            const first = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const repairPath = `${answersPath}.repair.json`;
            first.template.answers = first.template.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Repair answer for ${answer.rule_id}.`,
                evidence_files: ['tests/node/gates/quality-checklist/quality-checklist.test.ts']
            }));
            fs.writeFileSync(repairPath, JSON.stringify(first.template, null, 2) + '\n', 'utf8');
            const filledBytes = fs.readFileSync(repairPath, 'utf8');

            const repeated = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            assert.equal(repeated.status, 'repair_created');
            assert.equal(repeated.answers_path.replace(/\\/g, '/'), repairPath.replace(/\\/g, '/'));
            assert.equal(fs.readFileSync(repairPath, 'utf8'), filledBytes);

            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            preflight.changed_files = ['src/app.ts', 'src/after-coherent-restart.ts'];
            fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2) + '\n', 'utf8');
            const rebound = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            assert.equal(rebound.status, 'repair_created');
            assert.ok(rebound.template.answers.every((answer) => answer.status === 'PASS'));
            assert.ok(rebound.template.answers.every((answer) => answer.answer.startsWith('Repair answer for ')));
            const reboundBytes = fs.readFileSync(repairPath, 'utf8');
            const binding = JSON.parse(fs.readFileSync(`${repairPath}.binding.json`, 'utf8')) as {
                preflight_sha256: string;
            };
            assert.equal(binding.preflight_sha256, rebound.template.preflight_sha256);

            const afterRebind = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            assert.equal(afterRebind.answers_path.replace(/\\/g, '/'), repairPath.replace(/\\/g, '/'));
            assert.equal(fs.readFileSync(repairPath, 'utf8'), reboundBytes);

            const checklistResult = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath: repairPath,
                emitMetrics: false
            });
            assert.equal(checklistResult.exitCode, 0);
        } finally {
            fixture.cleanup();
        }
    });

    it('reuses an authenticated bare answers array at the existing repair path', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-repair-bare-answers-reuse' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.orchestratorRoot,
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, '{unsafe canonical json', 'utf8');

            const first = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const repairPath = `${answersPath}.repair.json`;
            const recoveryPath = `${repairPath}.recovery.json`;
            const submittedAnswers = first.template.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Submitted repair answer for ${answer.rule_id}.`
            }));
            fs.writeFileSync(repairPath, JSON.stringify(submittedAnswers, null, 2) + '\n', 'utf8');

            const repeated = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const persistedTemplate = JSON.parse(fs.readFileSync(repairPath, 'utf8')) as {
                event_source: string;
                answers: Array<{ status: string; answer: string }>;
            };

            assert.equal(repeated.status, 'repair_created');
            assert.equal(repeated.answers_path.replace(/\\/g, '/'), repairPath.replace(/\\/g, '/'));
            assert.equal(fs.existsSync(recoveryPath), false);
            assert.equal(persistedTemplate.event_source, 'quality-checklist-answers-template');
            assert.ok(persistedTemplate.answers.every((answer) => answer.status === 'PASS'));
            assert.ok(persistedTemplate.answers.every((answer) => answer.answer.startsWith('Submitted repair answer for ')));
        } finally {
            fixture.cleanup();
        }
    });

    it('normalizes an authenticated bare answers array at the canonical answers path', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-canonical-bare-answers-reuse' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.orchestratorRoot,
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            const first = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const submittedAnswers = first.template.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Submitted canonical answer for ${answer.rule_id}.`
            }));
            fs.writeFileSync(answersPath, JSON.stringify(submittedAnswers, null, 2) + '\n', 'utf8');

            const repeated = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const persistedTemplate = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
                event_source: string;
                answers: Array<{ status: string; answer: string }>;
            };

            assert.equal(repeated.status, 'refreshed');
            assert.equal(repeated.answers_path.replace(/\\/g, '/'), answersPath.replace(/\\/g, '/'));
            assert.equal(fs.existsSync(`${answersPath}.repair.json`), false);
            assert.match(repeated.warning || '', /normalized to the bound template at the existing path/iu);
            assert.equal(persistedTemplate.event_source, 'quality-checklist-answers-template');
            assert.ok(persistedTemplate.answers.every((answer) => answer.status === 'PASS'));
            assert.ok(persistedTemplate.answers.every((answer) => answer.answer.startsWith('Submitted canonical answer for ')));

            const checklistResult = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath,
                emitMetrics: false
            });
            assert.equal(checklistResult.exitCode, 0);
            assert.ok(checklistResult.outputLines.includes('QUALITY_CHECKLIST_PASSED'));
        } finally {
            fixture.cleanup();
        }
    });

    it('keeps an unauthenticated bare answers array fail-closed', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-unbound-bare-answers' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.orchestratorRoot,
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            const unboundAnswers = UNIVERSAL_QUALITY_RULE_IDS.map((ruleId) => ({
                rule_id: ruleId,
                status: 'PASS',
                answer: `Unbound answer for ${ruleId}.`
            }));
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, JSON.stringify(unboundAnswers, null, 2) + '\n', 'utf8');
            const originalBytes = fs.readFileSync(answersPath, 'utf8');

            const result = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });

            assert.equal(result.status, 'repair_created');
            assert.equal(result.answers_path.replace(/\\/g, '/'), `${answersPath}.repair.json`.replace(/\\/g, '/'));
            assert.equal(fs.readFileSync(answersPath, 'utf8'), originalBytes);
        } finally {
            fixture.cleanup();
        }
    });

    it('preserves unchanged repair answers while blanking changed and new policy rules', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-repair-partial-policy-refresh' });
        try {
            const changedRuleId = 'zz_custom_repair_changed_rule';
            const newRuleId = 'zz_custom_repair_new_rule';
            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
            config.optional_quality_checks.rules.push(buildTestQualityRule(changedRuleId));
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.orchestratorRoot,
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, '{unsafe canonical json', 'utf8');
            const first = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const repairPath = `${answersPath}.repair.json`;
            first.template.answers = first.template.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Original repair answer for ${answer.rule_id}.`
            }));
            fs.writeFileSync(repairPath, JSON.stringify(first.template, null, 2) + '\n', 'utf8');

            const changedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
            const changedRule = changedConfig.optional_quality_checks.rules.find((rule) => rule.id === changedRuleId);
            assert.ok(changedRule);
            changedRule.prompt = 'Changed repair-draft prompt requiring a fresh answer.';
            changedConfig.optional_quality_checks.rules.push(buildTestQualityRule(newRuleId));
            fs.writeFileSync(configPath, JSON.stringify(changedConfig, null, 2) + '\n', 'utf8');

            const refreshed = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const answersByRuleId = new Map(refreshed.template.answers.map((answer) => [answer.rule_id, answer]));

            assert.equal(refreshed.status, 'repair_created');
            for (const ruleId of UNIVERSAL_QUALITY_RULE_IDS) {
                assert.equal(answersByRuleId.get(ruleId)?.status, 'PASS');
                assert.equal(answersByRuleId.get(ruleId)?.answer, `Original repair answer for ${ruleId}.`);
            }
            assert.equal(answersByRuleId.get(changedRuleId)?.status, '');
            assert.equal(answersByRuleId.get(changedRuleId)?.answer, '');
            assert.equal(answersByRuleId.get(newRuleId)?.status, '');
            assert.equal(answersByRuleId.get(newRuleId)?.answer, '');
        } finally {
            fixture.cleanup();
        }
    });

    it('preserves a foreign cross-task repair draft and materializes a separate recovery candidate', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-repair-cross-task-recovery' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.orchestratorRoot,
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, '{unsafe canonical json', 'utf8');
            const first = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const repairPath = `${answersPath}.repair.json`;
            first.template.task_id = 'T-foreign-repair-draft';
            const unsafeRepairBytes = JSON.stringify(first.template, null, 2) + '\n';
            fs.writeFileSync(repairPath, unsafeRepairBytes, 'utf8');

            const recovered = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const recoveryPath = `${repairPath}.recovery.json`;
            const recoveryBytes = fs.readFileSync(recoveryPath, 'utf8');
            const repeated = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });

            assert.equal(recovered.status, 'repair_created');
            assert.equal(recovered.answers_path.replace(/\\/g, '/'), recoveryPath.replace(/\\/g, '/'));
            assert.match(recovered.warning || '', /existing repair candidate preserved/iu);
            assert.equal(fs.readFileSync(repairPath, 'utf8'), unsafeRepairBytes);
            assert.equal(fs.readFileSync(recoveryPath, 'utf8'), recoveryBytes);
            assert.equal(repeated.answers_path.replace(/\\/g, '/'), recoveryPath.replace(/\\/g, '/'));
        } finally {
            fixture.cleanup();
        }
    });

    it('rotates beyond occupied unsafe recovery candidates without overwriting them', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-repair-rotated-recovery' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.orchestratorRoot,
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            const repairPath = `${answersPath}.repair.json`;
            const recoveryPath = `${repairPath}.recovery.json`;
            const rotatedRecoveryPath = `${repairPath}.recovery.2.json`;
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, '{unsafe canonical json', 'utf8');
            fs.writeFileSync(repairPath, '{unsafe repair json', 'utf8');
            fs.writeFileSync(recoveryPath, '{unsafe recovery json', 'utf8');

            const recovered = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const rotatedRecoveryBytes = fs.readFileSync(rotatedRecoveryPath, 'utf8');
            const repeated = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });

            assert.equal(recovered.status, 'repair_created');
            assert.equal(recovered.answers_path.replace(/\\/g, '/'), rotatedRecoveryPath.replace(/\\/g, '/'));
            assert.match(recovered.warning || '', /existing repair candidate preserved/iu);
            assert.equal(fs.readFileSync(answersPath, 'utf8'), '{unsafe canonical json');
            assert.equal(fs.readFileSync(repairPath, 'utf8'), '{unsafe repair json');
            assert.equal(fs.readFileSync(recoveryPath, 'utf8'), '{unsafe recovery json');
            assert.equal(fs.readFileSync(rotatedRecoveryPath, 'utf8'), rotatedRecoveryBytes);
            assert.equal(repeated.answers_path.replace(/\\/g, '/'), rotatedRecoveryPath.replace(/\\/g, '/'));
        } finally {
            fixture.cleanup();
        }
    });

    it('stops after a selected repair candidate fails to materialize instead of retrying forever', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-repair-write-failure' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.orchestratorRoot,
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            const repairPath = `${answersPath}.repair.json`;
            const recoveryPath = `${repairPath}.recovery.json`;
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, '{unsafe canonical json', 'utf8');
            fs.mkdirSync(`${repairPath}.binding.json`, { recursive: true });

            assert.throws(
                () => materializeQualityChecklistAnswersTemplate({
                    repoRoot: fixture.repoRoot,
                    taskId: fixture.taskId,
                    preflightPath,
                    answersPath
                }),
                /repair template materialization failed/iu
            );

            assert.equal(fs.readFileSync(answersPath, 'utf8'), '{unsafe canonical json');
            assert.equal(fs.existsSync(recoveryPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('preserves materialized answers when refreshing a stale preflight binding with the same active rules', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-stale-answers-template' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const originalTemplate = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
                preflight_sha256: string;
                answers: Array<Record<string, unknown>>;
            };
            originalTemplate.answers = originalTemplate.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Preserved answer for ${String(answer.rule_id)}.`,
                evidence_files: ['tests/node/gates/quality-checklist/quality-checklist.test.ts'],
                actions_taken: [`Checked ${String(answer.rule_id)} before preflight refresh.`]
            }));
            fs.writeFileSync(answersPath, JSON.stringify(originalTemplate, null, 2) + '\n', 'utf8');
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            preflight.changed_files = ['src/app.ts', 'src/changed-after-template.ts'];
            fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2) + '\n', 'utf8');

            const refreshed = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            assert.equal(refreshed.status, 'refreshed');
            assert.notEqual(refreshed.template.preflight_sha256, originalTemplate.preflight_sha256);
            assert.ok(refreshed.template.answers.every((answer) => answer.status === 'PASS'));
            assert.ok(refreshed.template.answers.every((answer) => answer.answer.startsWith('Preserved answer for ')));
            assert.deepEqual(refreshed.template.answers[0].evidence_files, [
                'tests/node/gates/quality-checklist/quality-checklist.test.ts'
            ]);
        } finally {
            fixture.cleanup();
        }
    });

    it('preserves unchanged answers and blanks new rules when refreshing a changed policy template', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-policy-partial-template' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            const materialized = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            materialized.template.answers = materialized.template.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Original answer for ${answer.rule_id}.`
            }));
            fs.writeFileSync(answersPath, JSON.stringify(materialized.template, null, 2) + '\n', 'utf8');

            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
            config.optional_quality_checks.rules.push(buildTestQualityRule('zz_custom_new_quality_rule'));
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

            const refreshed = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            assert.equal(refreshed.status, 'refreshed');
            const answersByRuleId = new Map(refreshed.template.answers.map((answer) => [answer.rule_id, answer]));
            for (const ruleId of UNIVERSAL_QUALITY_RULE_IDS) {
                assert.equal(answersByRuleId.get(ruleId)?.status, 'PASS');
                assert.equal(answersByRuleId.get(ruleId)?.answer, `Original answer for ${ruleId}.`);
            }
            assert.equal(answersByRuleId.get('zz_custom_new_quality_rule')?.status, '');
            assert.equal(answersByRuleId.get('zz_custom_new_quality_rule')?.answer, '');
        } finally {
            fixture.cleanup();
        }
    });

    it('blanks changed custom rule answers without trusting policy-refresh carryover', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-policy-changed-rule-template' });
        try {
            const customRuleId = 'zz_custom_changed_quality_rule';
            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
            config.optional_quality_checks.rules.push(buildTestQualityRule(customRuleId));
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            const materialized = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            materialized.template.answers = materialized.template.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Original answer for ${answer.rule_id}.`
            }));
            fs.writeFileSync(answersPath, JSON.stringify(materialized.template, null, 2) + '\n', 'utf8');

            const changedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
            const changedRule = changedConfig.optional_quality_checks.rules.find((rule) => rule.id === customRuleId);
            assert.ok(changedRule);
            changedRule.prompt = 'Changed prompt that requires a new quality-checklist answer.';
            fs.writeFileSync(configPath, JSON.stringify(changedConfig, null, 2) + '\n', 'utf8');

            const refreshed = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });

            assert.equal(refreshed.status, 'refreshed');
            const answersByRuleId = new Map(refreshed.template.answers.map((answer) => [answer.rule_id, answer]));
            for (const ruleId of UNIVERSAL_QUALITY_RULE_IDS) {
                assert.equal(answersByRuleId.get(ruleId)?.status, 'PASS');
                assert.equal(answersByRuleId.get(ruleId)?.answer, `Original answer for ${ruleId}.`);
            }
            assert.equal(answersByRuleId.get(customRuleId)?.status, '');
            assert.equal(answersByRuleId.get(customRuleId)?.answer, '');
            assert.notEqual(
                refreshed.template.active_rule_fingerprints?.[customRuleId],
                materialized.template.active_rule_fingerprints?.[customRuleId]
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('does not trust tampered stale rule fingerprint metadata during policy refresh', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-policy-tampered-fingerprint-template' });
        try {
            const customRuleId = 'zz_custom_tampered_fingerprint_rule';
            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
            config.optional_quality_checks.rules.push(buildTestQualityRule(customRuleId));
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            const materialized = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            materialized.template.answers = materialized.template.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Original answer for ${answer.rule_id}.`
            }));

            const changedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
            const changedRule = changedConfig.optional_quality_checks.rules.find((rule) => rule.id === customRuleId);
            assert.ok(changedRule);
            changedRule.prompt = 'Changed prompt with tampered stale fingerprint metadata.';
            fs.writeFileSync(configPath, JSON.stringify(changedConfig, null, 2) + '\n', 'utf8');
            const currentTemplate = buildQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath
            });
            materialized.template.active_rule_fingerprints = {
                ...materialized.template.active_rule_fingerprints,
                [customRuleId]: currentTemplate.active_rule_fingerprints?.[customRuleId] || 'f'.repeat(64)
            };
            const tamperedOriginalBytes = JSON.stringify(materialized.template, null, 2) + '\n';
            fs.writeFileSync(answersPath, tamperedOriginalBytes, 'utf8');

            const refreshed = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });

            assert.equal(refreshed.status, 'repair_created');
            assert.match(refreshed.warning || '', /Unsafe existing answers template preserved/u);
            assert.equal(fs.readFileSync(answersPath, 'utf8'), tamperedOriginalBytes);
            assert.equal(refreshed.template.answers.every((answer) => answer.status === '' && answer.answer === ''), true);
        } finally {
            fixture.cleanup();
        }
    });

    it('does not trust tampered stale rule fingerprints even when the adjacent binding is edited', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-policy-tampered-binding-fingerprint-template' });
        try {
            const customRuleId = 'zz_custom_tampered_binding_fingerprint_rule';
            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
            config.optional_quality_checks.rules.push(buildTestQualityRule(customRuleId));
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            const materialized = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            materialized.template.answers = materialized.template.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Original answer for ${answer.rule_id}.`
            }));

            const changedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
            const changedRule = changedConfig.optional_quality_checks.rules.find((rule) => rule.id === customRuleId);
            assert.ok(changedRule);
            changedRule.prompt = 'Changed prompt with tampered stale template and binding metadata.';
            fs.writeFileSync(configPath, JSON.stringify(changedConfig, null, 2) + '\n', 'utf8');
            const currentTemplate = buildQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath
            });
            const currentFingerprint = currentTemplate.active_rule_fingerprints?.[customRuleId] || 'f'.repeat(64);
            materialized.template.active_rule_fingerprints = {
                ...materialized.template.active_rule_fingerprints,
                [customRuleId]: currentFingerprint
            };
            const tamperedOriginalBytes = JSON.stringify(materialized.template, null, 2) + '\n';
            fs.writeFileSync(answersPath, tamperedOriginalBytes, 'utf8');

            const bindingPath = `${answersPath}.binding.json`;
            const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8')) as {
                active_rule_ids: string[];
                active_rule_fingerprints: Record<string, string>;
                answers_template_policy_sha256: string;
            };
            binding.active_rule_fingerprints[customRuleId] = currentFingerprint;
            binding.answers_template_policy_sha256 = answersTemplatePolicySha256(
                binding.active_rule_ids,
                binding.active_rule_fingerprints
            );
            fs.writeFileSync(bindingPath, JSON.stringify(binding, null, 2) + '\n', 'utf8');

            const refreshed = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });

            assert.equal(refreshed.status, 'repair_created');
            assert.match(refreshed.warning || '', /Unsafe existing answers template preserved/u);
            assert.equal(fs.readFileSync(answersPath, 'utf8'), tamperedOriginalBytes);
            assert.equal(refreshed.template.answers.every((answer) => answer.status === '' && answer.answer === ''), true);
        } finally {
            fixture.cleanup();
        }
    });

    it('does not let tampered current rule fingerprints poison later policy refresh binding', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-policy-tampered-current-fingerprint-template' });
        try {
            const customRuleId = 'zz_custom_current_fingerprint_poison_rule';
            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const originalConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
            originalConfig.optional_quality_checks.rules.push(buildTestQualityRule(customRuleId));
            fs.writeFileSync(configPath, JSON.stringify(originalConfig, null, 2) + '\n', 'utf8');

            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            const materialized = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            materialized.template.answers = materialized.template.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Original answer for ${answer.rule_id}.`
            }));

            const changedConfig = JSON.parse(JSON.stringify(originalConfig)) as ReturnType<typeof buildDefaultWorkflowConfig>;
            const changedRule = changedConfig.optional_quality_checks.rules.find((rule) => rule.id === customRuleId);
            assert.ok(changedRule);
            changedRule.prompt = 'Changed prompt whose fingerprint is injected before policy refresh.';
            fs.writeFileSync(configPath, JSON.stringify(changedConfig, null, 2) + '\n', 'utf8');
            const changedTemplate = buildQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath
            });
            fs.writeFileSync(configPath, JSON.stringify(originalConfig, null, 2) + '\n', 'utf8');

            materialized.template.active_rule_fingerprints = {
                ...materialized.template.active_rule_fingerprints,
                [customRuleId]: changedTemplate.active_rule_fingerprints?.[customRuleId] || 'f'.repeat(64)
            };
            const tamperedOriginalBytes = JSON.stringify(materialized.template, null, 2) + '\n';
            fs.writeFileSync(answersPath, tamperedOriginalBytes, 'utf8');

            const repair = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            assert.equal(repair.status, 'repair_created');
            assert.match(repair.warning || '', /Unsafe existing answers template preserved/u);
            assert.equal(fs.readFileSync(answersPath, 'utf8'), tamperedOriginalBytes);
            assert.notEqual(repair.answers_path, answersPath.replace(/\\/g, '/'));
            assert.equal(fs.existsSync(repair.answers_path), true);

            fs.writeFileSync(configPath, JSON.stringify(changedConfig, null, 2) + '\n', 'utf8');
            const refreshed = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });

            assert.equal(refreshed.status, 'repair_created');
            assert.match(refreshed.warning || '', /Unsafe existing answers template preserved/u);
            assert.equal(fs.readFileSync(answersPath, 'utf8'), tamperedOriginalBytes);
            assert.equal(refreshed.template.answers.every((answer) => answer.status === '' && answer.answer === ''), true);
        } finally {
            fixture.cleanup();
        }
    });

    it('blanks changed baseline rule answers without trusting policy-refresh carryover', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-policy-changed-baseline-template' });
        try {
            const changedRuleId = 'code_simplification';
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            const materialized = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            materialized.template.answers = materialized.template.answers.map((answer) => ({
                ...answer,
                status: 'PASS',
                answer: `Original baseline answer for ${answer.rule_id}.`
            }));
            fs.writeFileSync(answersPath, JSON.stringify(materialized.template, null, 2) + '\n', 'utf8');

            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const changedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
            const changedRule = changedConfig.optional_quality_checks.rules.find((rule) => rule.id === changedRuleId);
            assert.ok(changedRule);
            changedRule.prompt = 'Changed baseline prompt that requires a new quality-checklist answer.';
            fs.writeFileSync(configPath, JSON.stringify(changedConfig, null, 2) + '\n', 'utf8');

            const refreshed = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });

            assert.equal(refreshed.status, 'refreshed');
            const answersByRuleId = new Map(refreshed.template.answers.map((answer) => [answer.rule_id, answer]));
            for (const ruleId of UNIVERSAL_QUALITY_RULE_IDS) {
                if (ruleId === changedRuleId) {
                    assert.equal(answersByRuleId.get(ruleId)?.status, '');
                    assert.equal(answersByRuleId.get(ruleId)?.answer, '');
                    continue;
                }
                assert.equal(answersByRuleId.get(ruleId)?.status, 'PASS');
                assert.equal(answersByRuleId.get(ruleId)?.answer, `Original baseline answer for ${ruleId}.`);
            }
            assert.equal(answersByRuleId.get(changedRuleId)?.status, '');
            assert.equal(answersByRuleId.get(changedRuleId)?.answer, '');
            assert.notEqual(
                refreshed.template.active_rule_fingerprints?.[changedRuleId],
                materialized.template.active_rule_fingerprints?.[changedRuleId]
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('does not preserve tampered stale answer entries while rebinding valid answers', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-stale-tampered-template' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            const materialized = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const staleAnswers = materialized.template.answers as unknown as Array<Record<string, unknown>>;
            staleAnswers[0] = {
                ...staleAnswers[0],
                status: 'PASS',
                answer: 'This valid stale answer should survive rebinding.'
            };
            staleAnswers[1] = {
                ...staleAnswers[1],
                status: 'PASS',
                answer: 'This tampered stale answer must not be preserved.',
                prompt: 'Injected prompt field'
            };
            fs.writeFileSync(answersPath, JSON.stringify(materialized.template, null, 2) + '\n', 'utf8');
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            preflight.changed_files = ['src/app.ts', 'src/rebound-context.ts'];
            fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2) + '\n', 'utf8');

            const refreshed = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            assert.equal(refreshed.status, 'refreshed');
            assert.equal(refreshed.template.answers[0].status, 'PASS');
            assert.equal(refreshed.template.answers[0].answer, 'This valid stale answer should survive rebinding.');
            assert.equal(refreshed.template.answers[1].status, '');
            assert.equal(refreshed.template.answers[1].answer, '');
            assert.equal(Object.hasOwn(refreshed.template.answers[1], 'prompt'), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('materializes a repair template without overwriting current-bound invalid answers', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-tampered-answers-template' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(
                fixture.repoRoot,
                'garda-agent-orchestrator',
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            const original = JSON.parse(fs.readFileSync(answersPath, 'utf8')) as {
                answers: Array<Record<string, unknown>>;
            };
            const tampered = JSON.parse(JSON.stringify(original)) as typeof original;
            tampered.answers[0].prompt = 'Tampered prompt.';
            const promptTamperedBytes = JSON.stringify(tampered, null, 2) + '\n';
            fs.writeFileSync(answersPath, promptTamperedBytes, 'utf8');

            const promptRefresh = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            assert.equal(promptRefresh.status, 'repair_created');
            assert.match(promptRefresh.warning || '', /Unsafe existing answers template preserved/u);
            assert.equal(promptRefresh.original_answers_path, answersPath.replace(/\\/g, '/'));
            assert.equal(fs.readFileSync(answersPath, 'utf8'), promptTamperedBytes);
            assert.equal(Object.hasOwn(promptRefresh.template.answers[0], 'prompt'), false);
            assert.equal(fs.existsSync(promptRefresh.answers_path), true);

            const malformed = JSON.parse(JSON.stringify(original)) as {
                answers: Array<Record<string, unknown>>;
            };
            malformed.answers[0].actions_taken = [42];
            const malformedBytes = JSON.stringify(malformed, null, 2) + '\n';
            fs.writeFileSync(answersPath, malformedBytes, 'utf8');
            const fieldRefresh = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath
            });
            assert.equal(fieldRefresh.status, 'repair_created');
            assert.equal(fs.readFileSync(answersPath, 'utf8'), malformedBytes);
            assert.equal(Object.hasOwn(fieldRefresh.template.answers[0], 'actions_taken'), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects stale preflight template bindings through stdin and inline JSON inputs', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-stale-template-input-modes' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const template = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath
            }).template;
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            preflight.changed_files = ['src/app.ts', 'src/new-context.ts'];
            fs.writeFileSync(preflightPath, JSON.stringify(preflight, null, 2) + '\n', 'utf8');
            const rawTemplate = JSON.stringify(template);

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersStdin: true,
                answersStdinText: rawTemplate,
                emitMetrics: false
            }), /answers template is stale for the current preflight/u);
            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: rawTemplate,
                emitMetrics: false
            }), /answers template is stale for the current preflight/u);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects stale policy template bindings through stdin and inline JSON inputs', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-stale-template-policy-input-modes' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const template = materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath
            }).template;
            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
            config.test_policy_refresh_marker = true;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
            const rawTemplate = JSON.stringify(template);

            for (const options of [
                { answersStdin: true, answersStdinText: rawTemplate },
                { answersJson: rawTemplate }
            ]) {
                assert.throws(() => runQualityChecklistCommand({
                    repoRoot: fixture.repoRoot,
                    taskId: fixture.taskId,
                    preflightPath,
                    ...options,
                    emitMetrics: false
                }), /answers template is stale for the current quality policy/u);
            }
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects answers template materialization outside the repo root', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-template-path-escape' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const outsideAnswersPath = path.join(path.dirname(fixture.repoRoot), 'quality-answers-template.json');

            assert.throws(() => materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath: outsideAnswersPath
            }), /Path must resolve inside repo root without symlink or junction escapes/u);
            assert.equal(fs.existsSync(outsideAnswersPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects a default answers template symlink that resolves outside the repo', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-default-template-symlink' });
        const outsideDir = path.join(path.dirname(fixture.repoRoot), `${fixture.taskId}-outside`);
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            fs.mkdirSync(outsideDir, { recursive: true });
            const outsideFile = path.join(outsideDir, 'answers.json');
            fs.writeFileSync(outsideFile, 'outside sentinel\n', 'utf8');
            const defaultAnswersPath = path.join(
                fixture.orchestratorRoot,
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            fs.mkdirSync(path.dirname(defaultAnswersPath), { recursive: true });
            try {
                fs.symlinkSync(outsideFile, defaultAnswersPath, 'file');
            } catch (error: unknown) {
                if (process.platform === 'win32') {
                    return;
                }
                throw error;
            }

            assert.throws(() => materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath
            }), /must (?:resolve inside repo root|not contain symbolic links)/u);
            assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside sentinel\n');
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
            fixture.cleanup();
        }
    });

    it('rejects a default answers template symlink to an internal repo file', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-default-template-internal-symlink' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const internalTarget = path.join(fixture.repoRoot, 'src', 'template-sentinel.ts');
            fs.writeFileSync(internalTarget, 'internal sentinel\n', 'utf8');
            const defaultAnswersPath = path.join(
                fixture.orchestratorRoot,
                'runtime',
                'tmp',
                `${fixture.taskId}-quality-checklist-answers.json`
            );
            fs.mkdirSync(path.dirname(defaultAnswersPath), { recursive: true });
            try {
                fs.symlinkSync(internalTarget, defaultAnswersPath, 'file');
            } catch (error: unknown) {
                if (process.platform === 'win32') return;
                throw error;
            }

            assert.throws(() => materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath
            }), /must not contain symbolic links/u);
            assert.equal(fs.readFileSync(internalTarget, 'utf8'), 'internal sentinel\n');
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects a symlinked default answers template parent outside the repo', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-default-template-parent-symlink' });
        const outsideDir = path.join(path.dirname(fixture.repoRoot), `${fixture.taskId}-outside`);
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            fs.mkdirSync(outsideDir, { recursive: true });
            const runtimeRoot = path.join(fixture.orchestratorRoot, 'runtime');
            fs.mkdirSync(runtimeRoot, { recursive: true });
            const tmpPath = path.join(runtimeRoot, 'tmp');
            try {
                fs.symlinkSync(outsideDir, tmpPath, process.platform === 'win32' ? 'junction' : 'dir');
            } catch (error: unknown) {
                if (process.platform === 'win32') {
                    return;
                }
                throw error;
            }

            assert.throws(() => materializeQualityChecklistAnswersTemplate({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath
            }), /must (?:resolve inside repo root|not contain symbolic links)/u);
            assert.equal(fs.existsSync(path.join(outsideDir, `${fixture.taskId}-quality-checklist-answers.json`)), false);
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
            fixture.cleanup();
        }
    });

    it('reads answers from stdin text without logging the raw JSON', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-answers-stdin' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const rawAnswers = JSON.stringify(buildPassAnswers());

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersStdin: true,
                answersStdinText: rawAnswers,
                emitMetrics: false
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_PASSED'));
            assert.equal(result.outputLines.join('\n').includes(rawAnswers), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('reports invalid JSON from answers-path without echoing file contents', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-invalid-answers-path' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'invalid-quality-answers.json');
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, '[{"rule_id":"code_simplification",', 'utf8');

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath,
                emitMetrics: false
            }), (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /AnswersPath must be valid JSON/u);
                assert.equal(error.message.includes('code_simplification'), false);
                return true;
            });
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects answers-path symlinks that resolve outside the repo root', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-answers-path-realpath-escape' });
        const outsideDir = path.join(path.dirname(fixture.repoRoot), `${fixture.taskId}-outside`);
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            fs.mkdirSync(outsideDir, { recursive: true });
            const outsideAnswersPath = path.join(outsideDir, 'quality-answers.json');
            fs.writeFileSync(outsideAnswersPath, JSON.stringify(buildPassAnswers()), 'utf8');

            const symlinkPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'outside-quality-answers.json');
            fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
            try {
                fs.symlinkSync(outsideAnswersPath, symlinkPath, 'file');
            } catch (error: unknown) {
                if (process.platform === 'win32') {
                    return;
                }
                throw error;
            }

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath: symlinkPath,
                emitMetrics: false
            }), /AnswersPath must resolve inside repo root/u);
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
            fixture.cleanup();
        }
    });

    it('rejects answers-path symlinks to internal repo files', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-answers-path-internal-symlink' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const internalTarget = path.join(fixture.repoRoot, 'src', 'answers-sentinel.json');
            fs.writeFileSync(internalTarget, JSON.stringify(buildPassAnswers()), 'utf8');
            const symlinkPath = path.join(fixture.orchestratorRoot, 'runtime', 'tmp', 'internal-quality-answers.json');
            fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
            try {
                fs.symlinkSync(internalTarget, symlinkPath, 'file');
            } catch (error: unknown) {
                if (process.platform === 'win32') return;
                throw error;
            }

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersPath: symlinkPath,
                emitMetrics: false
            }), /must not contain symbolic links/u);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects ambiguous answers input modes instead of applying precedence', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-answers-ambiguous' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answersPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'quality-answers.json');
            fs.mkdirSync(path.dirname(answersPath), { recursive: true });
            fs.writeFileSync(answersPath, JSON.stringify(buildPassAnswers()), 'utf8');

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(buildPassAnswers()),
                answersPath,
                emitMetrics: false
            }), /pass only one of --answers-json, --answers-path, or --answers-stdin/u);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects explicit artifact paths outside the repo root', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-artifact-escape' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const outsideArtifactPath = path.join(path.dirname(fixture.repoRoot), 'quality-checklist-outside.json');

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(buildPassAnswers()),
                artifactPath: outsideArtifactPath,
                emitMetrics: false
            }), /Path must resolve inside repo root without symlink or junction escapes/u);
            assert.equal(fs.existsSync(outsideArtifactPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects explicit metrics paths outside the repo root before writing the artifact', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-metrics-escape' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const artifactPath = path.join(fixture.repoRoot, 'custom-quality-checklist.json');
            const outsideMetricsPath = path.join(path.dirname(fixture.repoRoot), 'quality-checklist-metrics.jsonl');

            assert.throws(() => runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(buildPassAnswers()),
                artifactPath,
                metricsPath: outsideMetricsPath
            }), /Path must resolve inside repo root without symlink or junction escapes/u);
            assert.equal(fs.existsSync(artifactPath), false);
            assert.equal(fs.existsSync(outsideMetricsPath), false);
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects explicit preflight paths outside the repo root', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-preflight-escape' });
        const outsidePreflightPath = path.join(path.dirname(fixture.repoRoot), 'quality-checklist-preflight.json');
        try {
            fs.writeFileSync(outsidePreflightPath, JSON.stringify({
                task_id: fixture.taskId,
                changed_files: ['src/app.ts']
            }, null, 2) + '\n', 'utf8');

            assert.throws(() => buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath: outsidePreflightPath,
                answers: buildPassAnswers()
            }), /Path must resolve inside repo root without symlink or junction escapes/u);
        } finally {
            fs.rmSync(outsidePreflightPath, { force: true });
            fixture.cleanup();
        }
    });

    it('reports CONFIG_ERROR when preflight task_id does not match the checklist task', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-preflight-mismatch' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                task_id: 'T-quality-other',
                changed_files: ['src/app.ts']
            });

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswers()
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => (
                violation.includes("Preflight artifact task_id 'T-quality-other' does not match quality-checklist task_id")
            )));
            assert.deepEqual(artifact.changed_file_evidence.changed_files, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('skips cleanly when optional quality checks are disabled', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-disabled' });
        try {
            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const config = buildDefaultWorkflowConfig();
            config.optional_quality_checks.enabled = false;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
            const preflightPath = writeGateFixturePreflight(fixture);

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: '[]',
                emitMetrics: false
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_SKIPPED_DISABLED'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            assert.equal(artifact.status, 'SKIPPED_DISABLED');
            assert.deepEqual(artifact.answers, []);
        } finally {
            fixture.cleanup();
        }
    });

    it('reports CONFIG_ERROR when an enabled rule is missing an answer', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-config-error' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswers().slice(1)
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => violation.includes('Missing answer')));
        } finally {
            fixture.cleanup();
        }
    });

    it('explains stale materialized rule-set mismatch before unknown moved-rule answers', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-stale-moved-rules' });
        try {
            writeStaleMovedRuleWorkflowConfig(fixture);
            const preflightPath = writeGateFixturePreflight(fixture);
            const answers = [
                ...buildPassAnswers(),
                ...MOVED_PROJECT_LOCAL_RULE_IDS.map((ruleId) => ({
                    rule_id: ruleId,
                    status: 'PASS',
                    answer: `Answered moved rule ${ruleId}.`
                }))
            ];

            const result = runQualityChecklistCommand({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answersJson: JSON.stringify(answers),
                emitMetrics: false
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.includes('QUALITY_CHECKLIST_CONFIG_ERROR'));
            const artifactPathLine = result.outputLines.find((line) => line.startsWith('QualityChecklistArtifactPath: '));
            assert.ok(artifactPathLine);
            const artifact = JSON.parse(fs.readFileSync(artifactPathLine.replace('QualityChecklistArtifactPath: ', ''), 'utf8'));
            const diagnostic = String(artifact.violations[0] || '');

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.match(diagnostic, /baseline_version '2026-06-26\.t843' differs from shipped '2026-07-21\.t969'/u);
            assert.match(diagnostic, /classifier_intent_edge_cases/u);
            assert.match(diagnostic, /custom_garda_classifier_intent_edge_cases/u);
            assert.match(diagnostic, /Canonical enabled quality-check rule ids/u);
            assert.match(diagnostic, /deprecated or moved ids are not accepted/u);
            assert.equal(artifact.rules.some((rule: { id: string }) => rule.id === 'classifier_intent_edge_cases'), false);
            assert.equal(artifact.rules.some((rule: { id: string }) => rule.id === 'custom_garda_classifier_intent_edge_cases'), true);
            assert.ok(artifact.violations.some((violation: string) => (
                violation.includes("Answer references unknown or disabled quality-check rule 'classifier_intent_edge_cases'")
            )));
        } finally {
            fixture.cleanup();
        }
    });

    it('reports CONFIG_ERROR when configured rules have duplicate ids', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-duplicate-rule' });
        try {
            const configPath = path.join(fixture.orchestratorRoot, 'live', 'config', 'workflow-config.json');
            const config = buildDefaultWorkflowConfig();
            config.optional_quality_checks.rules.push({
                ...config.optional_quality_checks.rules[0],
                title: 'Duplicate code simplification'
            });
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
            const preflightPath = writeGateFixturePreflight(fixture);

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers: buildPassAnswers()
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => violation.includes('duplicate quality-check rule id')));
        } finally {
            fixture.cleanup();
        }
    });

    it('reports CONFIG_ERROR when an enabled rule has duplicate answers', () => {
        const fixture = createGateFixture({ taskId: 'T-quality-duplicate-answer' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture);
            const answers = buildPassAnswers();
            answers.push({ ...answers[0] });

            const artifact = buildQualityChecklistArtifact({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflightPath,
                answers
            });

            assert.equal(artifact.status, 'CONFIG_ERROR');
            assert.equal(artifact.outcome, 'FAIL');
            assert.ok(artifact.violations.some((violation) => violation.includes('Duplicate answer')));
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects forged and missing trust-boundary matrix evidence for security-sensitive preflight', () => {
        const fixture = declaredQualityFixture();
        try {
            const otherAnswers = fixture.answers.filter(answer => answer.rule_id !== TRUST_BOUNDARY_ANALYSIS_RULE_ID);
            const trustAnswer = fixture.answers.find(answer => answer.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID)!;
            const complete = fixture.artifact();
            assert.equal(complete.status, 'PENDING_VALIDATION', JSON.stringify(complete.violations));
            assert.deepEqual(
                [declaredPhases(complete)?.structural, declaredPhases(complete)?.execution, declaredPhases(complete)?.semantic],
                ['BOUND', 'PENDING', 'PENDING_INDEPENDENT_REVIEW']
            );
            assert.equal(
                complete.rules.find((rule) => rule.id === TRUST_BOUNDARY_ANALYSIS_RULE_ID)?.scope_applicability,
                'active'
            );

            const incompleteAnswer = {
                ...trustAnswer,
                trust_boundary_matrix: [{
                    boundary_id: 'TB-001',
                    boundary: 'Reviewer output receipt',
                    authority_source: 'Gate-owned launch',
                    mutable_inputs: ['review output'],
                    integrity_evidence: ['receipt hash'],
                    canonical_reconstruction: 'Rebuild from launch input.',
                    toctou_replay: 'Reject stale cycles.',
                    negative_paths: []
                }]
            };
            const incomplete = fixture.artifact([...otherAnswers, incompleteAnswer]);
            assert.equal(incomplete.status, 'CONFIG_ERROR');
            assert.ok(incomplete.violations.some((violation) => violation.includes('negative_paths')));

            const missing = fixture.artifact(otherAnswers);
            assert.equal(missing.status, 'CONFIG_ERROR');
            assert.ok(missing.violations.some((violation) => violation.includes(TRUST_BOUNDARY_ANALYSIS_RULE_ID)));

            const malformedDuplicate = fixture.artifact([
                    ...otherAnswers,
                    {
                        rule_id: TRUST_BOUNDARY_ANALYSIS_RULE_ID,
                        status: 'PASS',
                        answer: 'Claims trust-boundary coverage without a matrix.'
                    },
                    { rule_id: TRUST_BOUNDARY_ANALYSIS_RULE_ID }
                ]);
            assert.equal(malformedDuplicate.status, 'CONFIG_ERROR');
            assert.ok(malformedDuplicate.violations.some((violation) => violation.includes('Duplicate answer')));

            for (const evidenceFile of ['tests/node/missing.test.ts', 'src/app.ts']) {
                const unsupportedEvidence = structuredClone(trustAnswer);
                const matrix = unsupportedEvidence.trust_boundary_matrix as Array<Record<string, unknown>>;
                const negativePaths = matrix[0].negative_paths as Array<Record<string, unknown>>;
                negativePaths[0].evidence_files = [`${evidenceFile}#rejects stale trust-boundary evidence`];
                const invalidEvidence = fixture.artifact([...otherAnswers, unsupportedEvidence]);
                assert.equal(invalidEvidence.status, 'CONFIG_ERROR', evidenceFile);
                assert.ok(
                    invalidEvidence.violations.some((violation) => violation.includes(evidenceFile)),
                    evidenceFile
                );
            }
        } finally {
            fixture.cleanup();
        }
    });

    it('keeps the trust-boundary rule mandatory when optional checks are disabled', () => {
        const fixture = declaredQualityFixture('passed', undefined, false);
        try {
            const artifact = fixture.artifact();
            assert.equal(artifact.status, 'PENDING_VALIDATION', JSON.stringify(artifact.violations));
            assert.deepEqual(
                [declaredPhases(artifact)?.structural, declaredPhases(artifact)?.execution, declaredPhases(artifact)?.semantic],
                ['BOUND', 'PENDING', 'PENDING_INDEPENDENT_REVIEW']
            );
            assert.equal(artifact.active_rule_count, 1);
            assert.equal(artifact.answers[0].rule_id, TRUST_BOUNDARY_ANALYSIS_RULE_ID);
        } finally {
            fixture.cleanup();
        }
    });
});
