import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
    resolveReviewRemediationImpactAnalysis
} from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-remediation-impact-analysis';
import {
    getReviewRemediationSemanticSignals,
    groupReviewRemediationFiles
} from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-remediation-semantics';
import {
    classifyReviewRemediationFix
} from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-remediation-classification';
import {
    resolveReviewRemediationClassifyChangedFiles
} from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-remediation-artifacts';
import {
    excludeUnchangedDirtyWorkspaceBaselineFiles
} from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-shared';
import { fileSha256 } from '../../../../../../src/gates/shared/helpers';
import type {
    ReviewRemediationImpactAnalysis,
    ReviewRemediationScopeBoundary
} from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-types';

const TEST_FILE = 'tests/recovery/remediation.test.ts';

function buildImpactAnalysis(summary: string): ReviewRemediationImpactAnalysis {
    return {
        status: 'RECORDED',
        source: 'inline',
        summary,
        required_topics: [],
        affected_files: [TEST_FILE]
    };
}

describe('cli/commands/gate-flows/recovery remediation units', () => {
    it('blocks reuse when remediation expands non-test scope beyond the failed review', () => {
        const scopeBoundary: ReviewRemediationScopeBoundary = {
            status: 'BLOCKED',
            previousChangedFiles: [TEST_FILE],
            currentChangedFiles: [TEST_FILE, 'src/outside.ts'],
            expandedFiles: ['src/outside.ts'],
            expandedNonTestFiles: ['src/outside.ts'],
            allowedTestOnlyExpansionFiles: []
        };

        const classification = classifyReviewRemediationFix(scopeBoundary, ['code', 'test']);

        assert.equal(classification.scope_category, 'expanded_non_test_blocked');
        assert.equal(classification.blocked_before_reuse, true);
        assert.deepEqual(classification.invalidated_review_types, ['code', 'test']);
        assert.deepEqual(classification.preserved_review_types, []);
    });

    it('invalidates all required lanes when evidence-only remediation names an unknown lane', () => {
        const scopeBoundary: ReviewRemediationScopeBoundary = {
            status: 'OK',
            previousChangedFiles: [TEST_FILE],
            currentChangedFiles: [],
            expandedFiles: [],
            expandedNonTestFiles: [],
            allowedTestOnlyExpansionFiles: []
        };

        const classification = classifyReviewRemediationFix(
            scopeBoundary,
            ['code', 'test'],
            undefined,
            [],
            undefined,
            { reviewEvidenceOnly: true, remediationReviewType: 'db' }
        );

        assert.equal(classification.category, 'review_evidence_only');
        assert.match(classification.rationale, /review type is missing or not required/u);
        assert.equal(classification.non_test_review_reuse_candidate, false);
        assert.deepEqual(classification.invalidated_review_types, ['code', 'test']);
        assert.deepEqual(classification.preserved_review_types, []);
    });

    it('normalizes and validates inline remediation impact analysis', () => {
        const summary = [
            `Reviewer finding: the failed test review identified missing recovery coverage in ${TEST_FILE}.`,
            `Intended fix: add assertions only in ${TEST_FILE} for the failed recovery branch.`,
            `Affected files and contracts: ${TEST_FILE} is the only affected file and production contracts are unchanged.`,
            'API/runtime/artifact/test impact: test impact is limited to recovery assertions; API, runtime, and artifacts stay unchanged.',
            'Possible side effects: an incorrect scope classification could relaunch unrelated review lanes.',
            'Required targeted checks: run the focused remediation unit target and the recovery integration target.',
            'Scope or review-type changes: the remediation remains in test scope and only the failed test lane must rerun.',
            'Related blocker or follow-up decision: no separate follow-up is needed because the finding is fixed in scope.'
        ].join(' ');

        const result = resolveReviewRemediationImpactAnalysis(
            '.',
            { impactAnalysis: summary },
            [TEST_FILE]
        );

        assert.equal(result.source, 'inline');
        assert.deepEqual(result.affected_files, [TEST_FILE]);
        assert.match(result.summary, /only affected file/u);
    });

    it('rejects remediation impact-analysis files outside the repository root', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-remediation-repo-'));
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-remediation-outside-'));
        const outsidePath = path.join(outsideRoot, 'impact-analysis.json');
        fs.writeFileSync(outsidePath, '{}\n', 'utf8');

        try {
            assert.throws(
                () => resolveReviewRemediationImpactAnalysis(
                    repoRoot,
                    { impactAnalysisPath: outsidePath },
                    []
                ),
                /must stay inside the repository root/u
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it('separates remediation file groups and ignores negated source mentions', () => {
        const scopeBoundary: ReviewRemediationScopeBoundary = {
            status: 'OK',
            previousChangedFiles: ['src/app.ts', TEST_FILE],
            currentChangedFiles: ['src/app.ts', TEST_FILE],
            expandedFiles: [],
            expandedNonTestFiles: [],
            allowedTestOnlyExpansionFiles: []
        };
        const impactAnalysis = buildImpactAnalysis(
            `Reviewer finding and intended fix affect ${TEST_FILE}; no changes to src/app.ts; ` +
            'test impact is isolated, runtime behavior stays unchanged, and focused validation covers the scope.'
        );

        assert.deepEqual(
            groupReviewRemediationFiles(
                ['src/app.ts', TEST_FILE, 'docs/recovery.md', 'runtime/reviews/result.json'],
                ['(^|/)tests?/']
            ),
            {
                source: ['src/app.ts'],
                test: [TEST_FILE],
                docs: ['docs/recovery.md'],
                runtime_artifact: ['runtime/reviews/result.json']
            }
        );
        assert.deepEqual(
            getReviewRemediationSemanticSignals(
                scopeBoundary,
                impactAnalysis,
                ['(^|/)tests?/']
            ),
            {
                category: 'test_coverage_only',
                matchedSignals: ['test-only impact analysis files'],
                rationale: 'remediation impact analysis names only classifier-recognized test files inside the previous failed-review scope',
                changedFiles: [TEST_FILE],
                scopeSource: 'impact_analysis_files'
            }
        );
    });

    it('invalidates test-scoped refactor review when focused test churn crosses the policy threshold', () => {
        const scopeBoundary: ReviewRemediationScopeBoundary = {
            status: 'OK',
            previousChangedFiles: [TEST_FILE],
            currentChangedFiles: [TEST_FILE],
            expandedFiles: [],
            expandedNonTestFiles: [],
            allowedTestOnlyExpansionFiles: []
        };
        const classification = classifyReviewRemediationFix(
            scopeBoundary,
            ['code', 'refactor', 'test'],
            buildImpactAnalysis(
                `Reviewer finding and intended fix affect only ${TEST_FILE}; test impact is isolated and runtime behavior stays unchanged.`
            ),
            ['(^|/)tests?/'],
            undefined,
            {
                testRefactorChangedLinesThreshold: 20,
                testRefactorStructuralPathRegexes: [],
                changedFileStats: { [TEST_FILE]: { changed_lines: 21 } }
            }
        );

        assert.equal(classification.category, 'test_coverage_only');
        assert.deepEqual(classification.invalidated_review_types, ['refactor', 'test']);
        assert.deepEqual(classification.preserved_review_types, ['code']);
        assert.equal(classification.evidence.test_refactor_trigger_reason, 'test_domain_changed_lines_threshold');
        assert.equal(classification.evidence.test_refactor_changed_lines_total, 21);
    });

    it('invalidates only the failed lane for review-evidence-only remediation', () => {
        const scopeBoundary: ReviewRemediationScopeBoundary = {
            status: 'OK',
            previousChangedFiles: ['src/app.ts', TEST_FILE],
            currentChangedFiles: [],
            expandedFiles: [],
            expandedNonTestFiles: [],
            allowedTestOnlyExpansionFiles: []
        };
        const classification = classifyReviewRemediationFix(
            scopeBoundary,
            ['api', 'code', 'performance', 'refactor', 'security', 'test'],
            buildImpactAnalysis(
                'Reviewer finding: delegated API review evidence cited a line outside the current file. ' +
                'Intended fix: replace only that reviewer output; source, runtime, API, and test behavior remain unchanged.'
            ),
            ['(^|/)tests?/'],
            undefined,
            {
                reviewEvidenceOnly: true,
                remediationReviewType: 'api'
            }
        );

        assert.equal(classification.category, 'review_evidence_only');
        assert.deepEqual(classification.invalidated_review_types, ['api']);
        assert.deepEqual(classification.preserved_review_types, [
            'code',
            'performance',
            'refactor',
            'security',
            'test'
        ]);
        assert.equal(classification.non_test_review_reuse_candidate, true);
        assert.equal(classification.test_review_reuse_candidate, true);
    });

    it('excludes only unchanged dirty-workspace baseline files from evidence-only live scope', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-remediation-baseline-'));
        const taskFile = 'src/app.ts';
        const baselineFile = 'tests/user-change.test.ts';
        const absoluteBaselinePath = path.join(repoRoot, ...baselineFile.split('/'));
        fs.mkdirSync(path.dirname(absoluteBaselinePath), { recursive: true });
        fs.writeFileSync(absoluteBaselinePath, 'user-owned baseline\n', 'utf8');
        const baseline = {
            schema_version: 1,
            captured_at_utc: '2026-08-14T00:00:00.000Z',
            changed_files: [baselineFile],
            file_hashes: {
                [baselineFile]: fileSha256(absoluteBaselinePath)
            }
        };

        try {
            assert.deepEqual(
                excludeUnchangedDirtyWorkspaceBaselineFiles(
                    repoRoot,
                    [taskFile, baselineFile],
                    baseline
                ),
                [taskFile]
            );

            fs.writeFileSync(absoluteBaselinePath, 'later mutation\n', 'utf8');
            assert.deepEqual(
                excludeUnchangedDirtyWorkspaceBaselineFiles(
                    repoRoot,
                    [taskFile, baselineFile],
                    baseline
                ),
                [taskFile, baselineFile]
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('builds refresh classification scope from prior, replay, expansion, and explicit files', () => {
        const changedFiles = resolveReviewRemediationClassifyChangedFiles(
            {
                plannedChangedFiles: ['src/app.ts'],
                changedFiles: ['tests\\recovery\\existing.test.ts'],
                detectionSource: 'explicit_changed_files'
            },
            {
                status: 'OK',
                previousChangedFiles: ['src/app.ts'],
                currentChangedFiles: ['src/app.ts', TEST_FILE],
                expandedFiles: [TEST_FILE],
                expandedNonTestFiles: [],
                allowedTestOnlyExpansionFiles: [TEST_FILE]
            },
            ['docs/recovery.md']
        );

        assert.deepEqual(changedFiles, [
            'docs/recovery.md',
            'src/app.ts',
            'tests/recovery/existing.test.ts',
            TEST_FILE
        ]);
    });
});
