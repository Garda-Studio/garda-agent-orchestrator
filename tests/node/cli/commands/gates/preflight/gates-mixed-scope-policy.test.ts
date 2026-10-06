import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, it, type TestContext } from 'node:test';

import { runClassifyChangeCommand } from '../../../../../../src/cli/commands/gates';
import { applyEffectiveTaskPolicyToPreflightResult } from '../../../../../../src/cli/commands/gate-flows/compile/compile-flow-classify';
import { buildDomainReviewSurface } from '../../../../../../src/cli/commands/gate-flows/compile/compile-flow-shared-evidence';
import { runFullSuiteValidationCommand } from '../../../../../../src/cli/commands/gate-flows/full-suite/full-suite-validation-flow';
import { readReviewCatalogConfigFile } from '../../../../../../src/core/review-catalog';
import { isFullSuiteNotRequiredForDocsOnlyScope } from '../../../../../../src/gates/full-suite/full-suite-validation';
import { classifyChange, getClassificationConfig, getReviewCapabilities } from '../../../../../../src/gates/preflight/classify-change';
import { buildEffectiveReviewSnapshot } from '../../../../../../src/policy/effective-review-snapshot';
import { loadProfilesData } from '../../../../../../src/policy/profile-resolver';
import { resolveProfileReviewCatalogPolicy } from '../../../../../../src/policy/profile-review-catalog-policy';
import {
    buildTaskProfilePolicySnapshot,
    resolveTaskProfileReviewTriggerPolicy,
    resolveTaskProfileSelectionFromSnapshot
} from '../../../../../../src/policy/task-profile-policy-snapshot';
import { isolateTestRunnerEnvironment } from '../../../../process-environment-fixtures';
import { writeCompilePassEvidence } from '../../gate-test-helpers';
import {
    createTempRepo,
    getReviewsRoot,
    initializeGitRepo,
    loadTaskEntryRulePack,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue
} from './gates-preflight-fixtures';

beforeEach((context) => (context as TestContext).after(isolateTestRunnerEnvironment()));

const NON_DOC_SCOPES = [
    ['package.json'], ['package-lock.json'], ['pnpm-lock.yaml'], ['yarn.lock'],
    ['pom.xml'], ['pyproject.toml'], ['Pipfile'], ['poetry.lock'],
    ['Cargo.toml'], ['Cargo.lock'], ['composer.json'], ['composer.lock'],
    ['.env'], ['.env.local'], ['tsconfig.json'], ['eslint.config.mjs'],
    ['tests/widget.test.ts'], ['.agents/workflows/route.md'],
    ['.github/workflows/check.yml'], ['Dockerfile'],
    ['build.gradle'], ['go.mod'], ['requirements.txt'], ['src/app.ts'],
    ['tsconfig.json', 'tests/widget.test.ts'],
    ['tsconfig.json', '.agents/workflows/route.md'],
    ['tests/widget.test.ts', '.agents/workflows/route.md']
];
const DOCUMENTATION_FILES = ['README.md', 'docs/guide.md'];
const TASK_INTENT = 'Adjust project settings and maintain existing checks';

interface PolicyFixture {
    root: string;
    taskId: string;
    preflightPath: string;
}

function writeFile(root: string, relativePath: string, content: string): void {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
}

function createPolicyRoot(): string {
    const root = createTempRepo();
    const configRoot = 'garda-agent-orchestrator/live/config';
    writeFile(root, `${configRoot}/profiles.json`, JSON.stringify(loadProfilesData(path.resolve('template/config/profiles.json'))));
    writeFile(root, `${configRoot}/review-capabilities.json`, JSON.stringify({
        code: true, db: true, security: true, refactor: true,
        api: true, test: true, performance: true, infra: true, dependency: true
    }));
    writeFile(root, `${configRoot}/workflow-config.json`, JSON.stringify({
        full_suite_validation: {
            enabled: true,
            command: 'node suite-fixture.cjs',
            timeout_ms: 30000,
            placement: 'after_compile_before_reviews'
        },
        orchestrator_work_policy: { mode: 'require_operator_confirmation' }
    }));
    return root;
}

function createPolicyClassifier(profile: string) {
    const root = createPolicyRoot();
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const snapshot = buildTaskProfilePolicySnapshot(bundleRoot, profile, {
        reviewExecutionPolicyMode: 'strict_sequential',
        reviewExecutionPolicyConfigured: true,
        fullSuiteValidationEnabled: true
    });
    const catalog = readReviewCatalogConfigFile(path.join(bundleRoot, 'live/config/review-catalog.json'));
    const classificationConfig = getClassificationConfig(root, {
        reviewTriggerPolicy: resolveTaskProfileReviewTriggerPolicy(snapshot)
    });
    const reviewCapabilities = getReviewCapabilities(root);
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        snapshot.source.effective_profile,
        snapshot.review_lane_selection.profile_review_policy,
        snapshot.review_lane_selection.review_capabilities,
        catalog
    );
    return {
        root,
        classify(files: string[]) {
            const result = classifyChange({
                normalizedFiles: files, repoRoot: root, taskIntent: TASK_INTENT,
                changedLinesTotal: files.length, classificationConfig, reviewCapabilities,
                reviewExecutionPolicyMode: snapshot.review_execution_policy.mode
            });
            const policy = resolveTaskProfileSelectionFromSnapshot(snapshot, result.scope_category, {
                domainSurface: buildDomainReviewSurface(result),
                protectedControlPlaneChanged: result.triggers.protected_control_plane_changed,
                protectedControlPlaneDocsOnly: result.triggers.protected_control_plane_docs_only
            });
            applyEffectiveTaskPolicyToPreflightResult(result, policy.effective_policy);
            const effectiveReviewSnapshot = buildEffectiveReviewSnapshot({
                catalog, profilePolicy, profileSnapshotSha256: snapshot.snapshot_hash,
                legacyRequiredReviews: result.required_reviews,
                scopeCategory: result.scope_category, taskIntent: TASK_INTENT,
                changedFiles: files,
                taskTriggers: Object.fromEntries(Object.entries(result.triggers)
                    .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')),
                reviewExecutionPolicyMode: snapshot.review_execution_policy.mode,
                reviewDependencyGraph: snapshot.review_execution_policy.review_dependency_graph,
                fullSuiteValidation: snapshot.review_execution_policy.full_suite_validation
            });
            return { ...result, required_reviews: effectiveReviewSnapshot.required_reviews,
                effective_review_snapshot: effectiveReviewSnapshot };
        }
    };
}

function createPolicyFixture(profile: string, plannedFiles: string[]): PolicyFixture {
    const root = createPolicyRoot();
    const taskId = 'T-MIXED-POLICY';
    writeFile(root, 'suite-fixture.cjs', [
        'const assert = require("node:assert/strict");',
        'const fs = require("node:fs");',
        'assert.equal(process.cwd(), __dirname);',
        'fs.appendFileSync("suite-ran.log", "ran\\n");'
    ].join('\n'));
    writeFile(root, '.gitignore', 'garda-agent-orchestrator/runtime/\nsuite-ran.log\n');
    seedTaskQueue(root, taskId, 'TODO', profile, 'Mixed scope policy fixture', TASK_INTENT);
    seedInitAnswers(root);
    initializeGitRepo(root);
    runEnterTaskMode({
        repoRoot: root,
        taskId,
        taskSummary: TASK_INTENT,
        plannedChangedFiles: plannedFiles,
        orchestratorWork: true,
        operatorConfirmed: 'yes',
        operatorConfirmedAtUtc: new Date().toISOString()
    });
    assert.equal(loadTaskEntryRulePack(root, taskId).exitCode, 0);
    runHandshakeForTask(root, taskId);
    runShellSmokeForTask(root, taskId);
    return { root, taskId, preflightPath: path.join(getReviewsRoot(root), `${taskId}-preflight.json`) };
}

function classify(fixture: PolicyFixture, files: string[]) {
    const result = runClassifyChangeCommand({
        repoRoot: fixture.root,
        taskId: fixture.taskId,
        taskIntent: TASK_INTENT,
        changedFiles: files,
        outputPath: fixture.preflightPath,
        emitMetrics: false
    });
    return JSON.parse(result.outputText);
}

async function runSuite(fixture: PolicyFixture) {
    writeCompilePassEvidence(fixture.root, fixture.taskId, fixture.preflightPath);
    const result = await runFullSuiteValidationCommand({
        taskId: fixture.taskId,
        preflightPath: fixture.preflightPath,
        repoRoot: fixture.root
    });
    assert.equal(result.exitCode, 0, result.outputText);
    return JSON.parse(fs.readFileSync(
        path.join(getReviewsRoot(fixture.root), `${fixture.taskId}-full-suite-validation.json`), 'utf8'
    ));
}

function assertReviewMonotonicity(before: ReturnType<typeof classify>, after: ReturnType<typeof classify>): void {
    assert.deepEqual(after.required_reviews, after.effective_review_snapshot.required_reviews);
    for (const [lane, required] of Object.entries(before.effective_review_snapshot.required_reviews)) {
        if (required === true) {
            assert.equal(after.effective_review_snapshot.required_reviews[lane], true, `required lane removed: ${lane}`);
        }
    }
    assert.equal(isFullSuiteNotRequiredForDocsOnlyScope(before), false);
    assert.equal(isFullSuiteNotRequiredForDocsOnlyScope(after), false);
}

const PROFILES = ['balanced', 'fast', 'strict'];

it('prevents documentation from removing final review requirements for every non-doc scope', () => {
    let verifiedCombinations = 0;
    for (const profile of PROFILES) {
        const fixture = createPolicyClassifier(profile);
        try {
            for (const nonDocFiles of NON_DOC_SCOPES) {
                const baselineContents = nonDocFiles.map(file => fs.existsSync(path.join(fixture.root, file))
                    ? fs.readFileSync(path.join(fixture.root, file), 'utf8') : null);
                for (const file of nonDocFiles) writeFile(fixture.root, file, 'changed non-documentation input\n');
                const before = fixture.classify(nonDocFiles);
                for (const docFile of DOCUMENTATION_FILES) {
                    writeFile(fixture.root, docFile, '# Usage\nDocumentation only.\n');
                    const after = fixture.classify([...nonDocFiles, docFile]);
                    assertReviewMonotonicity(before, after);
                    assert.notEqual(after.scope_category, 'docs-only', profile + ': ' + nonDocFiles.join(',') + ' + ' + docFile);
                    verifiedCombinations += 1;
                    fs.unlinkSync(path.join(fixture.root, docFile));
                }
                for (const [index, file] of nonDocFiles.entries()) {
                    const baseline = baselineContents[index];
                    if (typeof baseline === 'string') writeFile(fixture.root, file, baseline);
                    else fs.unlinkSync(path.join(fixture.root, file));
                }
            }
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    }
    assert.equal(verifiedCombinations, PROFILES.length * NON_DOC_SCOPES.length * DOCUMENTATION_FILES.length);
});

it('prevents documentation from exempting a mixed config scope from the native full-suite gate', async () => {
    const executionEvidence = [];
    for (const profile of PROFILES) {
        const fixture = createPolicyFixture(profile, ['pom.xml', 'README.md']);
        try {
            writeFile(fixture.root, 'pom.xml', '<project/>\n');
            const before = classify(fixture, ['pom.xml']);
            const beforeSuite = await runSuite(fixture);
            writeFile(fixture.root, 'README.md', '# Usage\n');
            const after = classify(fixture, ['pom.xml', 'README.md']);
            const afterSuite = await runSuite(fixture);
            assertReviewMonotonicity(before, after);
            executionEvidence.push([
                profile, beforeSuite.status, afterSuite.status,
                afterSuite.required !== false,
                afterSuite.skip_reason !== 'DOCS_ONLY_SCOPE_NOT_REQUIRED',
                fs.readFileSync(path.join(fixture.root, 'suite-ran.log'), 'utf8')
            ]);
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    }
    assert.deepEqual(executionEvidence, PROFILES.map(profile => [profile, 'PASSED', 'PASSED', true, true, 'ran\nran\n']));
});

it('genuine docs-only and test-only policies remain applicable', async () => {
    for (const profile of PROFILES) {
        const docs = createPolicyFixture(profile, ['README.md', 'docs/guide.md']);
        const tests = createPolicyFixture(profile, ['tests/widget.test.ts']);
        try {
            for (const file of DOCUMENTATION_FILES) writeFile(docs.root, file, '# Usage\n');
            const docsPolicy = classify(docs, DOCUMENTATION_FILES);
            const docsSuite = await runSuite(docs);
            writeFile(tests.root, 'tests/widget.test.ts', 'test fixture changed\n');
            const testPolicy = classify(tests, ['tests/widget.test.ts']);
            const testSuite = await runSuite(tests);
            assert.equal(docsPolicy.scope_category, 'docs-only');
            assert.ok(Object.values(docsPolicy.required_reviews).every(value => value === false));
            assert.equal(docsSuite.status, 'SKIPPED');
            assert.equal(docsSuite.skip_reason, 'DOCS_ONLY_SCOPE_NOT_REQUIRED');
            assert.equal(fs.existsSync(path.join(docs.root, 'suite-ran.log')), false);
            assert.equal(testPolicy.scope_category, 'test-only');
            assert.equal(testPolicy.required_reviews.code, false);
            assert.equal(testPolicy.required_reviews.security, false);
            assert.equal(testPolicy.required_reviews.refactor, false);
            assert.equal(testPolicy.required_reviews.test, true);
            assert.equal(testSuite.status, 'PASSED');
        } finally {
            fs.rmSync(docs.root, { recursive: true, force: true });
            fs.rmSync(tests.root, { recursive: true, force: true });
        }
    }
});
