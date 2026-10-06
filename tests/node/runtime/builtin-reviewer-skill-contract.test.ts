import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { copyDirectoryRecursive } from '../../../src/materialization/init/init-filesystem';
import { readBaselineSkillManifest } from '../../../src/runtime/skill-manifest';
import { stringSha256 } from '../../../src/gate-runtime/hash';
import { buildReviewCoverageContract } from '../../../src/gates/review/review-coverage-ledger';
import {
    buildReviewContextHandoffArtifactPaths,
    buildReviewContextHandoffArtifacts
} from '../../../src/gates/review-context/review-context-artifacts';

function materializeReviewerSkill(context: TestContext, reviewType: string) {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-reviewer-contract-'));
    context.after(() => {
        assert.equal(path.dirname(bundleRoot), path.resolve(os.tmpdir()));
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    });
    const skillId = `${reviewType}-review`;
    const sourceRoot = path.join(getRepoRoot(), 'template', 'skills', skillId);
    const skillRoot = path.join(bundleRoot, 'live', 'skills', skillId);
    const customRoot = path.join(bundleRoot, 'live', 'skills', 'project-specialist');
    fs.mkdirSync(customRoot, { recursive: true });
    const customPath = path.join(customRoot, 'SKILL.md');
    fs.writeFileSync(customPath, '# Project-owned specialist\n', 'utf8');
    copyDirectoryRecursive(sourceRoot, skillRoot, { destinationRoot: bundleRoot });
    for (const file of ['SKILL.md', 'skill.json']) {
        assert.deepEqual(fs.readFileSync(path.join(skillRoot, file)), fs.readFileSync(path.join(sourceRoot, file)));
    }
    assert.equal(fs.readFileSync(customPath, 'utf8'), '# Project-owned specialist\n');
    return { bundleRoot, skillId, skillRoot };
}

function assertFindingsOnlyInstructions(skillRoot: string) {
    const instructions = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const manifest = readBaselineSkillManifest(skillRoot);
    assert.match(manifest.summary, /findings-only/iu);
    assert.doesNotMatch(manifest.summary, /verdict|pass\/fail/iu);
    assert.match(instructions, /sole instruction and output-format authority/u);
    assert.match(instructions, /only permitted write is the exact `ReviewOutputPath`/u);
    assert.match(instructions, /every coverage-ledger obligation/u);
    assert.match(instructions, /F-000/u);
    assert.match(instructions, /advisory/u);
    assert.doesNotMatch(instructions, /REVIEW PASSED|REVIEW FAILED|## Verdict|## Deferred Findings|Justification:|docs\/reviews\/TEMPLATE\.md|historical audit-only guidance/u);
    assert.doesNotMatch(instructions, /Config source:|exact verdict token|Produce final .*verdict/u);
    for (const reference of manifest.references) {
        assert.ok(fs.existsSync(path.join(skillRoot, 'references', reference)));
    }
}

function assertGeneratedHandoff(reviewType: string, skillRoot: string, bundleRoot: string) {
    const skillPath = path.join(skillRoot, 'SKILL.md');
    const skillId = `${reviewType}-review`;
    const skillHash = stringSha256(fs.readFileSync(skillPath, 'utf8'));
    const coverageContract = buildReviewCoverageContract({
        reviewType,
        changedFiles: [`src/${reviewType}-example.ts`]
    });
    const handoff = buildReviewContextHandoffArtifacts({
        reviewType,
        selectedSkill: {
            skill_id: skillId,
            skill_path: skillPath,
            skill_sha256: skillHash,
            skill_directory_path: skillRoot,
            skill_entrypoint_exists: true,
            candidate_skill_ids: [skillId]
        },
        paths: buildReviewContextHandoffArtifactPaths(path.join(bundleRoot, `${reviewType}-review-context.json`)),
        ruleContextSections: { source_file_count: 0, summary: {}, source_files: [] },
        promptArtifactText: '# Assigned review scope\n',
        stripExamplesApplied: false,
        stripCodeBlocksApplied: false,
        coverageContract
    });
    assert.equal(handoff.reviewerHandoff.role_prompt.selected_skill.skill_sha256, skillHash);
    assert.match(handoff.rolePromptArtifactText, /generated prompt and output-template artifacts are the sole output-format authority/u);
    assert.match(handoff.promptTemplateArtifactText, /F-000/u);
    const jsonFormStart = handoff.outputTemplateArtifactText.indexOf('\n{');
    assert.notEqual(jsonFormStart, -1);
    const output = JSON.parse(handoff.outputTemplateArtifactText.slice(jsonFormStart + 1));
    assert.equal(output.review_type, reviewType);
    assert.deepEqual(output.coverage_ledger.entries.map((entry: { obligation_id: string }) => entry.obligation_id), coverageContract.obligations.map(entry => entry.id));
    assert.deepEqual(Object.keys(output.findings), ['critical', 'high', 'medium', 'low']);
    for (const forbidden of ['verdict', 'status', 'disposition', 'remediation']) {
        assert.equal(Object.hasOwn(output, forbidden), false);
    }
}

for (const reviewType of ['code', 'db']) {
    test(`${reviewType} reviewer materializes findings-only instructions compatible with its generated handoff`, context => {
        const { bundleRoot, skillRoot } = materializeReviewerSkill(context, reviewType);
        assertFindingsOnlyInstructions(skillRoot);
        assertGeneratedHandoff(reviewType, skillRoot, bundleRoot);
    });
}
