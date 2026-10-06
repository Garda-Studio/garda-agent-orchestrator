import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { copyDirectoryRecursive } from '../../../src/materialization/init/init-filesystem';
import { readBaselineSkillManifest } from '../../../src/runtime/skill-manifest';
import { stringSha256 } from '../../../src/gate-runtime/hash';
import { extractReviewVerdictToken } from '../../../src/gate-runtime/review/review-verdict-tokens';
import { getReviewArtifactFindingsEvidence } from '../../../src/gates/completion/completion-verdict';
import { buildReviewCoverageContract } from '../../../src/gates/review/review-coverage-ledger';
import {
    buildReviewContextHandoffArtifactPaths,
    buildReviewContextHandoffArtifacts
} from '../../../src/gates/review-context/review-context-artifacts';

type ReviewType = 'security' | 'refactor';

const CONFLICTING_RECIPES = /REVIEW PASSED|REVIEW FAILED|## Verdict|## Deferred Findings|Justification:|docs\/reviews\/TEMPLATE\.md|historical audit-only guidance|Config source:|exact verdict token|Produce final .*verdict/u;

function materializeSkill(context: TestContext, reviewType: ReviewType) {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-security-refactor-contract-'));
    context.after(() => {
        assert.equal(path.dirname(bundleRoot), path.resolve(os.tmpdir()));
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    });
    const skillId = reviewType + '-review';
    const sourceRoot = path.join(getRepoRoot(), 'template', 'skills', skillId);
    const skillRoot = path.join(bundleRoot, 'live', 'skills', skillId);
    const customPath = path.join(bundleRoot, 'live', 'skills', 'project-specialist', 'SKILL.md');
    fs.mkdirSync(path.dirname(customPath), { recursive: true });
    fs.writeFileSync(customPath, '# Project-owned specialist\n', 'utf8');
    copyDirectoryRecursive(sourceRoot, skillRoot, { destinationRoot: bundleRoot });
    for (const name of ['SKILL.md', 'skill.json']) {
        assert.deepEqual(fs.readFileSync(path.join(skillRoot, name)), fs.readFileSync(path.join(sourceRoot, name)));
    }
    const instructions = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const manifest = readBaselineSkillManifest(skillRoot);
    for (const reference of manifest.references) {
        assert.ok(fs.existsSync(path.join(skillRoot, 'references', reference)));
    }
    return { bundleRoot, skillId, skillRoot, customPath, instructions, manifest };
}

function generatedHandoff(fixture: ReturnType<typeof materializeSkill>, reviewType: ReviewType) {
    const skillPath = path.join(fixture.skillRoot, 'SKILL.md');
    const skillHash = stringSha256(fixture.instructions);
    const coverage = buildReviewCoverageContract({
        reviewType,
        changedFiles: ['src/' + reviewType + '-example.ts']
    });
    const handoff = buildReviewContextHandoffArtifacts({
        reviewType,
        selectedSkill: {
            skill_id: fixture.skillId, skill_path: skillPath, skill_sha256: skillHash,
            skill_directory_path: fixture.skillRoot, skill_entrypoint_exists: true,
            candidate_skill_ids: [fixture.skillId]
        },
        paths: buildReviewContextHandoffArtifactPaths(path.join(fixture.bundleRoot, reviewType + '-context.json')),
        ruleContextSections: { source_file_count: 0, summary: {}, source_files: [] },
        promptArtifactText: '# Assigned review scope\n',
        stripExamplesApplied: false, stripCodeBlocksApplied: false, coverageContract: coverage
    });
    const formStart = handoff.outputTemplateArtifactText.indexOf('\n{');
    assert.notEqual(formStart, -1);
    const form = JSON.parse(handoff.outputTemplateArtifactText.slice(formStart + 1));
    assert.equal(handoff.reviewerHandoff.role_prompt.selected_skill.skill_sha256, skillHash);
    assert.equal(form.review_type, reviewType);
    assert.deepEqual(form.coverage_ledger.entries.map((entry: { obligation_id: string }) => entry.obligation_id),
        coverage.obligations.map(entry => entry.id));
    assert.deepEqual(Object.keys(form.findings), ['critical', 'high', 'medium', 'low']);
    return { handoff, form };
}

function assertReportingBoundary(instructions: string, summary: string) {
    assert.match(summary, /findings-only/u);
    assert.doesNotMatch(summary, /verdict|pass\/fail/iu);
    assert.match(instructions, /sole instruction and output-format authority/u);
    assert.match(instructions, /only permitted write is the exact.*ReviewOutputPath/u);
    assert.match(instructions, /never launch another agent/u);
    assert.match(instructions, /Do not independently load task-lifecycle rules, task state, commands or token-economy configuration/u);
    assert.match(instructions, /every coverage-ledger obligation/u);
    assert.match(instructions, /re-sweep the complete current assigned scope/u);
    assert.match(instructions, /Standalone advice is not a mandatory review receipt/u);
}

test('security contract rejects legacy output and lifecycle authority recipes after materialization', context => {
    const fixture = materializeSkill(context, 'security');
    const { handoff, form } = generatedHandoff(fixture, 'security');
    assert.doesNotMatch(fixture.instructions, CONFLICTING_RECIPES);
    assert.equal(Object.hasOwn(form, 'verdict'), false);
    assert.equal(Object.hasOwn(form, 'status'), false);
    assert.equal(Object.hasOwn(form, 'disposition'), false);
    assert.equal(Object.hasOwn(form, 'remediation'), false);
    assertReportingBoundary(fixture.instructions, fixture.manifest.summary);
    assert.match(fixture.instructions, /exploit paths and abuse scenarios/u);
    assert.match(fixture.instructions, /negative paths.*cross-owner access.*replay and forged evidence/u);
    assert.match(fixture.instructions, /authorization.*ownership.*tenant/u);
    assert.match(handoff.rolePromptArtifactText, /sole output-format authority/u);
    assert.equal(fs.readFileSync(fixture.customPath, 'utf8'), '# Project-owned specialist\n');
});

test('refactor contract rejects legacy output and lifecycle authority recipes while preserving behavior lenses', context => {
    const fixture = materializeSkill(context, 'refactor');
    const { handoff, form } = generatedHandoff(fixture, 'refactor');
    assert.doesNotMatch(fixture.instructions, CONFLICTING_RECIPES);
    assert.equal(Object.hasOwn(form, 'verdict'), false);
    assert.equal(Object.hasOwn(form, 'status'), false);
    assert.equal(Object.hasOwn(form, 'disposition'), false);
    assert.equal(Object.hasOwn(form, 'remediation'), false);
    assertReportingBoundary(fixture.instructions, fixture.manifest.summary);
    assert.match(fixture.instructions, /public contracts and user-visible flows.*errors and side effects/u);
    assert.match(fixture.instructions, /unused imports and variables, stale helpers, dead code/u);
    assert.match(fixture.instructions, /negative paths.*hidden side effects or behavior drift/u);
    assert.match(handoff.rolePromptArtifactText, /sole output-format authority/u);
    assert.equal(fs.readFileSync(fixture.customPath, 'utf8'), '# Project-owned specialist\n');
});

test('security and refactor reviewers preserve the generated narrow F-000 validation boundary', context => {
    for (const reviewType of ['security', 'refactor'] as const) {
        const fixture = materializeSkill(context, reviewType);
        const { handoff } = generatedHandoff(fixture, reviewType);
        assert.match(fixture.instructions, /Missing prior focused execution evidence alone is not a finding or residual risk/u);
        assert.match(fixture.instructions, /exactly one relevant authenticated repository target/u);
        assert.match(fixture.instructions, /reserved F-000 only with the exact evidence-only marker and target required by the generated handoff/u);
        assert.match(handoff.promptTemplateArtifactText, /F-000/u);
        assert.match(handoff.rolePromptArtifactText, /\[garda:evidence-only:missing-focused-validation\]/u);
    }
});

test('historical security and refactor Markdown verdicts remain readable', () => {
    for (const reviewType of ['security', 'refactor'] as const) {
        const prefix = reviewType.toUpperCase() + ' REVIEW ';
        const passed = prefix + 'PASSED', failed = prefix + 'FAILED';
        const historical = [
            '# Historical review', '## Validation Notes',
            'Reviewed src/example.ts:1 and its contract tests.',
            '## Findings by Severity', 'None', '## Deferred Findings', 'None',
            '## Residual Risks', 'None', '## Verdict', passed
        ].join('\n');
        assert.equal(extractReviewVerdictToken(historical, passed, failed, reviewType), passed);
        assert.equal(extractReviewVerdictToken('## Verdict\n' + failed, passed, failed, reviewType), failed);
        assert.equal(getReviewArtifactFindingsEvidence('/historical-review.md', historical).status, 'PASS');
    }
});
