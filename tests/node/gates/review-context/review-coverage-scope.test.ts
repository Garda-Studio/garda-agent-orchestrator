import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import { createTempRepo } from '../../cli/commands/gate-test-repo-bootstrap';
import { initGitRepo } from '../git-fixtures';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile/compile-gate';
import { assertReviewTreeStateFresh, buildReviewTreeState } from '../../../../src/gates/review/review-tree-state';
import { resolveReviewCoverageChangedFiles } from '../../../../src/gates/review-context/review-coverage-scope';
import { buildAuthoritativeReviewCoverageContract } from '../../../../src/gates/review-context/review-context-coverage';
import { getReviewContextContractViolations } from '../../../../src/gates/review-context/review-context-contract';
import { buildReviewContext, writeTaskModeArtifactFixture } from './build-review-context-fixtures';
import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../../../src/policy/review-trigger-policy';
import { validateReviewFindingsContract } from '../../../../src/gates/review/review-findings-artifact-verdict';
import { REVIEW_FINDINGS_SCHEMA_VERSION } from '../../../../src/gates/review/review-findings-schema';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    computeReviewContextReuseHash
} from '../../../../src/gates/review-reuse';

const DOCUMENTATION_FILES = [
    'CHANGELOG.md',
    'docs/usage.md',
    'template/skills/orchestration/SKILL.md'
];
const DOCUMENTATION_TEST = 'tests/node/docs/usage.test.ts';
const TASK_ID = 'T-136-docs-scope-regression';
const CONTEXT_HASH = 'a'.repeat(64);
const TREE_HASH = 'b'.repeat(64);
const PREFLIGHT_HASH = 'c'.repeat(64);

for (const reviewType of ['code', 'test']) {
    for (const schemaVersion of [3, 4]) {
        test(`${reviewType} schema ${schemaVersion} frozen custom test policy binds covered documentation`, (t) => {
            const repoRoot = createTempRepo(t);
            fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator/live/config/paths.json'), JSON.stringify({
                runtime_roots: ['src/', 'custom-specs/']
            }), 'utf8');
            initGitRepo(repoRoot);
            const changedFiles = ['docs/usage.md', 'custom-specs/check.ts'];
            for (const file of changedFiles) {
                fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
                fs.writeFileSync(path.join(repoRoot, file), '// Reviewed content.\n', 'utf8');
            }
            const frozenPolicy = { ...DEFAULT_REVIEW_TRIGGER_POLICY, test_path_regexes: ['(^|/)custom-specs/'] };
            fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews'), { recursive: true });
            writeTaskModeArtifactFixture(repoRoot, TASK_ID, {
                provider: 'Codex', canonicalSourceOfTruth: 'Codex', routedTo: null,
                executionProviderSource: 'explicit_provider', runtimeIdentityStatus: 'resolved'
            });
            const preflight = {
                task_id: TASK_ID, detection_source: 'explicit_changed_files', changed_files: changedFiles,
                mode: 'FULL_PATH', scope_category: 'docs-only', required_reviews: { [reviewType]: true },
                profile_policy_snapshot: { review_trigger_policy: frozenPolicy }
            };
            const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify(preflight), 'utf8');
            const contextPath = path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/context.json');
            const contextOptions = {
                reviewType, depth: 1, preflightPath, outputPath: contextPath, repoRoot,
                tokenEconomyConfigPath: path.join(repoRoot, 'garda-agent-orchestrator/live/config/token-economy.json'),
                scopedDiffMetadataPath: path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews/scoped.json')
            };
            buildReviewContext(contextOptions);
            const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
            context.schema_version = schemaVersion;
            assert.deepEqual(context.tree_state.domain_scope_fingerprints.domains.test.changed_files, ['custom-specs/check.ts']);
            assert.deepEqual(context.tree_state.review_trigger_policy, frozenPolicy);
            const checkFresh = () => assertReviewTreeStateFresh({ repoRoot, reviewContext: context, contextPath, gateName: 'regression-test' });
            assert.doesNotThrow(checkFresh);
            const originalHash = computeReviewContextReuseHash(context);
            fs.appendFileSync(path.join(repoRoot, changedFiles[0]), '// Changed reviewed criteria.\n');
            assert.throws(checkFresh, /stale/u);
            buildReviewContext(contextOptions);
            const changedContext = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
            changedContext.schema_version = schemaVersion;
            assert.notEqual(computeReviewContextReuseHash(changedContext), originalHash);
            changedContext.tree_state.review_trigger_policy = { ...frozenPolicy, test_path_regexes: ['forged'] };
            const violations = getReviewContextContractViolations({
                contextPath, reviewContext: changedContext, expectedTaskId: TASK_ID, expectedReviewType: reviewType,
                expectedPreflightPayload: preflight, repoRoot
            });
            assert.ok(violations.some((violation) => violation.includes('tree_state.review_trigger_policy')));
        });
    }
}

function configureDocumentationTests(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator/live/config/paths.json'), JSON.stringify({
        runtime_roots: ['src/', 'tests/']
    }), 'utf8');
    fs.mkdirSync(path.dirname(path.join(repoRoot, DOCUMENTATION_TEST)), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, DOCUMENTATION_TEST), '// Documentation contract test.\nexport const criteria = true;\n', 'utf8');
}

for (const includeTests of [false, true]) {
for (const reviewType of ['code', 'test', 'security']) {
    test(`${reviewType} documentation${includeTests ? ' and test' : '-only'} coverage permits concrete findings evidence`, (t) => {
        const repoRoot = createTempRepo(t);
        if (includeTests) configureDocumentationTests(repoRoot);
        for (const file of DOCUMENTATION_FILES) {
            fs.mkdirSync(path.dirname(path.join(repoRoot, file)), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, file), '# Criteria\nKeep planning intent separate from validation outcomes.\n', 'utf8');
        }
        const preflight = {
            changed_files: [...DOCUMENTATION_FILES, ...(includeTests ? [DOCUMENTATION_TEST] : [])],
            detection_source: 'explicit_changed_files',
            scope_category: 'docs-only'
        };
        const scope = buildAuthoritativeReviewCoverageContract({ reviewType, preflight, repoRoot });
        assert.deepEqual(scope.changedFiles, [...DOCUMENTATION_FILES, ...(includeTests && reviewType === 'test' ? [DOCUMENTATION_TEST] : [])]);
        assert.equal(scope.contract.required, true);
        const executionContract = buildReviewRemediationReviewContract({
            taskId: TASK_ID, reviewType, preflightSha256: PREFLIGHT_HASH, fullReviewScope: scope.changedFiles
        });
        const evidence = (file: string) => [{
            location: `${file}:2`,
            observation: 'The criteria distinguish planning intent from recorded validation outcomes.'
        }];
        const report = {
            schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
            task_id: TASK_ID,
            review_type: reviewType,
            review_context_sha256: CONTEXT_HASH,
            tree_state_sha256: TREE_HASH,
            validation_notes: [{
                id: 'N-001', topic: 'criteria-authority',
                note: 'The documentation describes planning intent and keeps completion tied to recorded outcomes.',
                evidence: evidence('docs/usage.md')
            }],
            coverage_ledger: {
                coverage_contract_sha256: scope.contract.contract_sha256,
                entries: scope.contract.obligations.map((obligation) => ({
                    obligation_id: obligation.id,
                    evidence: evidence(obligation.kind === 'file' ? obligation.target : 'docs/usage.md'),
                    finding_ids: []
                }))
            },
            review_execution: {
                mode: 'FULL', contract_sha256: executionContract.contract_sha256,
                covered_delta_targets: [], inspected_prior_finding_ids: []
            },
            findings: { critical: [], high: [], medium: [], low: [] },
            residual_risks: [], reviewer_notes: []
        };
        const validate = () => validateReviewFindingsContract({
            content: JSON.stringify(report), expectedTaskId: TASK_ID, expectedReviewType: reviewType,
            expectedReviewContextSha256: CONTEXT_HASH, expectedTreeStateSha256: TREE_HASH,
            coverageContract: scope.contract, expectedReviewExecutionContract: executionContract, repoRoot
        });
        assert.deepEqual(validate().violations, []);
        assert.equal(validate().valid, true);

        report.validation_notes[0].evidence = evidence('docs/unrelated.md');
        assert.equal(validate().valid, false);
        assert.ok(validate().violations.some((violation) => violation.includes('outside the')));
        report.validation_notes[0].evidence = evidence('docs/usage.md');
        report.coverage_ledger.entries[0].evidence = evidence('docs/usage.md');
        assert.equal(validate().valid, false, 'Each file obligation must still cite its own target.');

        assert.deepEqual(computeReviewReuseCodeScopeFingerprint(reviewType, preflight, repoRoot).non_test_changed_files, []);
        assert.deepEqual(computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_relevant_changed_files,
            includeTests ? [DOCUMENTATION_TEST] : []);
    });
}
}

test('mixed runtime coverage retains existing lane scope and documentation reuse exclusions', (t) => {
    const repoRoot = createTempRepo(t);
    const preflight = {
        changed_files: ['src/app.ts', 'tests/node/app.test.ts', 'docs/usage.md'],
        detection_source: 'explicit_changed_files'
    };
    assert.deepEqual(resolveReviewCoverageChangedFiles({ reviewType: 'code', preflight, repoRoot }), ['src/app.ts']);
    assert.deepEqual(resolveReviewCoverageChangedFiles({ reviewType: 'test', preflight, repoRoot }), [
        'src/app.ts', 'tests/node/app.test.ts'
    ]);
    assert.deepEqual(resolveReviewCoverageChangedFiles({ reviewType: 'security', preflight, repoRoot }), ['src/app.ts']);
});

test('empty and test-only code scopes do not expand to supporting or unrelated paths', (t) => {
    const repoRoot = createTempRepo(t);
    for (const changedFiles of [[], ['tests/node/app.test.ts']]) {
        assert.deepEqual(resolveReviewCoverageChangedFiles({
            reviewType: 'code', preflight: { changed_files: changedFiles, scope_category: 'docs-only' }, repoRoot
        }), []);
    }
});

for (const reviewType of ['code', 'test']) {
    test(`${reviewType} closeout test suffix does not trigger documentation expansion`, (t) => {
        const repoRoot = createTempRepo(t);
        const preflight = { changed_files: [
            'docs/usage.md', 'garda-agent-orchestrator/runtime/manual-validation/probe.test.ts'
        ] };
        assert.deepEqual(resolveReviewCoverageChangedFiles({ reviewType, preflight, repoRoot }),
            reviewType === 'test' ? [preflight.changed_files[1]] : []);
    });

    test(`${reviewType} documentation-and-tests freshness respects test-byte ownership`, (t) => {
        const repoRoot = createTempRepo(t);
        configureDocumentationTests(repoRoot);
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, DOCUMENTATION_TEST), '// Existing task change.\n');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs/usage.md'), '# Criteria\nReviewed intent.\n', 'utf8');
        const changedFiles = ['docs/usage.md', DOCUMENTATION_TEST];
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
        const context = {
            schema_version: 4, review_type: reviewType,
            tree_state: buildReviewTreeState({
                repoRoot, detectionSource: 'explicit_changed_files', includeUntracked: true, changedFiles, metrics: snapshot
            })
        };
        const checkFresh = () => assertReviewTreeStateFresh({
            repoRoot, reviewContext: context, contextPath: path.join(repoRoot, 'review-context.json'), gateName: 'regression-test'
        });
        assert.doesNotThrow(checkFresh);
        fs.appendFileSync(path.join(repoRoot, DOCUMENTATION_TEST), '// Changed assertion after review.\n');
        if (reviewType === 'test') assert.throws(checkFresh, /stale/u);
        else assert.doesNotThrow(checkFresh);
    });
}

for (const includeTests of [false, true]) {
for (const reviewType of ['code', 'test', 'security', 'refactor', 'architecture-boundary']) {
    for (const detectionSource of ['git_auto', 'explicit_changed_files']) {
        test(`${reviewType} ${detectionSource} rejects mutation of reviewed documentation${includeTests ? ' alongside tests' : ''}`, (t) => {
            const repoRoot = createTempRepo(t);
            if (includeTests) configureDocumentationTests(repoRoot);
            initGitRepo(repoRoot);
            if (includeTests) fs.appendFileSync(path.join(repoRoot, DOCUMENTATION_TEST), '// Changed test.\n');
            fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
            const docPath = path.join(repoRoot, 'docs/usage.md');
            fs.writeFileSync(docPath, '# Usage\nOriginal criteria.\n', 'utf8');
            const context = () => {
                const snapshot = getWorkspaceSnapshot(repoRoot, detectionSource, true,
                    ['docs/usage.md', ...(includeTests ? [DOCUMENTATION_TEST] : [])]);
                const changedFiles = resolveReviewCoverageChangedFiles({
                    reviewType, preflight: { changed_files: snapshot.changed_files, detection_source: detectionSource }, repoRoot
                });
                return {
                    schema_version: 4, review_type: reviewType,
                    tree_state: buildReviewTreeState({
                        repoRoot, detectionSource, includeUntracked: true, changedFiles: snapshot.changed_files, metrics: snapshot
                    }),
                    review_execution: buildReviewRemediationReviewContract({
                        taskId: TASK_ID, reviewType, preflightSha256: PREFLIGHT_HASH, fullReviewScope: changedFiles
                    })
                };
            };
            const originalContext = context();
            const checkFresh = () => assertReviewTreeStateFresh({
                repoRoot, reviewContext: originalContext, contextPath: path.join(repoRoot, 'review-context.json'), gateName: 'regression-test'
            });
            assert.doesNotThrow(checkFresh);
            const reuseHash = computeReviewContextReuseHash(originalContext);
            assert.equal(computeReviewContextReuseHash(context()), reuseHash, 'Unchanged reviewed docs retain their reuse binding.');
            fs.writeFileSync(docPath, '# Usage\nDifferent criteria after launch.\n', 'utf8');
            assert.throws(checkFresh, /stale/u);
            assert.notEqual(computeReviewContextReuseHash(context()), reuseHash, 'Changed reviewed docs invalidate historical reuse.');
        });
    }
}
}
