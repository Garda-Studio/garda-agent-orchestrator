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
import { reviewFindingsReportJsonSchema, validateReviewFindingsReport } from '../../../src/gates/review/review-findings-schema';
import {
    buildReviewContextHandoffArtifactPaths,
    buildReviewContextHandoffArtifacts
} from '../../../src/gates/review-context/review-context-artifacts';

const SKILLS = [
    { reviewType: 'dependency', id: 'dependency-review', source: 'template/skills/dependency-review' },
    { reviewType: 'test', id: 'testing-strategy', source: 'template/skill-packs/quality-architecture/skills/testing-strategy' },
    { reviewType: 'infra', id: 'devops-k8s', source: 'template/skill-packs/devops-k8s/skills/devops-k8s' }
] as const;
type Skill = typeof SKILLS[number];

// These are the conflicting recipes present before T-153-5, not accepted report formats.
const LEGACY_RECIPES = /REVIEW PASSED|REVIEW FAILED|## Verdict|## Deferred Findings|Justification:|docs\/reviews\/TEMPLATE\.md|historical audit-only guidance|Config source:|exact verdict token|Produce final .*verdict/u;

function materializeSkill(context: TestContext, skill: Skill) {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-dependency-test-infra-contract-'));
    context.after(() => {
        assert.equal(path.dirname(bundleRoot), path.resolve(os.tmpdir()));
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    });
    const sourceRoot = path.join(getRepoRoot(), skill.source);
    const skillRoot = path.join(bundleRoot, 'live', 'skills', skill.id);
    const customPath = path.join(bundleRoot, 'live', 'skills', 'project-specialist', 'SKILL.md');
    fs.mkdirSync(path.dirname(customPath), { recursive: true });
    fs.writeFileSync(customPath, '# Project-owned specialist\n', 'utf8');
    copyDirectoryRecursive(sourceRoot, skillRoot, { destinationRoot: bundleRoot });
    for (const name of ['SKILL.md', 'skill.json']) {
        assert.deepEqual(fs.readFileSync(path.join(skillRoot, name)), fs.readFileSync(path.join(sourceRoot, name)));
    }
    const manifest = readBaselineSkillManifest(skillRoot);
    assert.equal(manifest.id, skill.id);
    for (const reference of manifest.references) {
        assert.deepEqual(fs.readFileSync(path.join(skillRoot, 'references', reference)),
            fs.readFileSync(path.join(sourceRoot, 'references', reference)));
    }
    return { bundleRoot, skillRoot, customPath, instructions: fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8') };
}

function generatedHandoff(fixture: ReturnType<typeof materializeSkill>, skill: Skill) {
    const hash = stringSha256(fixture.instructions);
    const coverage = buildReviewCoverageContract({ reviewType: skill.reviewType, changedFiles: ['src/' + skill.reviewType + '-example.ts'] });
    const handoff = buildReviewContextHandoffArtifacts({
        reviewType: skill.reviewType,
        selectedSkill: {
            skill_id: skill.id, skill_path: path.join(fixture.skillRoot, 'SKILL.md'),
            skill_sha256: hash, skill_directory_path: fixture.skillRoot,
            skill_entrypoint_exists: true, candidate_skill_ids: [skill.id]
        },
        paths: buildReviewContextHandoffArtifactPaths(path.join(fixture.bundleRoot, skill.reviewType + '-context.json')),
        ruleContextSections: { source_file_count: 0, summary: {}, source_files: [] },
        promptArtifactText: '# Assigned review scope\n', stripExamplesApplied: false,
        stripCodeBlocksApplied: false, coverageContract: coverage
    });
    const formStart = handoff.outputTemplateArtifactText.indexOf('\n{');
    assert.notEqual(formStart, -1);
    const form = JSON.parse(handoff.outputTemplateArtifactText.slice(formStart + 1));
    assert.equal(handoff.reviewerHandoff.role_prompt.selected_skill.skill_sha256, hash);
    assert.equal(form.review_type, skill.reviewType);
    assert.deepEqual(Object.keys(form).sort(), [...reviewFindingsReportJsonSchema.required].sort());
    assert.deepEqual(form.coverage_ledger.entries.map((entry: { obligation_id: string }) => entry.obligation_id),
        coverage.obligations.map(entry => entry.id));
    assert.deepEqual(Object.keys(form.findings), ['critical', 'high', 'medium', 'low']);
    return { handoff, form };
}

for (const skill of SKILLS) {
    test(`${skill.reviewType} materializes a generated findings-only contract without legacy output or lifecycle recipes`, context => {
        const fixture = materializeSkill(context, skill);
        const { handoff, form } = generatedHandoff(fixture, skill);
        assert.doesNotMatch(fixture.instructions, LEGACY_RECIPES);
        assert.match(fixture.instructions, /sole instruction and output-format authority/u);
        assert.match(fixture.instructions, /only permitted write is the exact `ReviewOutputPath`/u);
        assert.match(fixture.instructions, /never launch another agent/u);
        assert.match(fixture.instructions, /Do not independently load task-lifecycle rules, task state, commands or token-economy configuration/u);
        assert.match(fixture.instructions, /re-sweep the complete current assigned scope/u);
        assert.match(fixture.instructions, /every coverage-ledger obligation exactly once/u);
        assert.match(fixture.instructions, /Standalone advice is not a mandatory review receipt/u);
        assert.match(handoff.rolePromptArtifactText, /sole output-format authority/u);
        for (const field of ['verdict', 'status', 'disposition', 'remediation']) {
            assert.equal(Object.hasOwn(form, field), false);
            const invalid = validateReviewFindingsReport({ ...form, [field]: 'override' }, {
                expectedTaskId: 'offline-example', expectedReviewType: skill.reviewType,
                allowStructuralOnlyReviewExecution: true
            });
            assert.equal(invalid.valid, false);
            assert.ok(invalid.violations.some(message => message.includes(field)), field);
        }
        assert.equal(fs.readFileSync(fixture.customPath, 'utf8'), '# Project-owned specialist\n');
    });
}

test('dependency, test and infra retain only the generated narrow focused-validation boundary', context => {
    for (const skill of SKILLS) {
        const fixture = materializeSkill(context, skill);
        const { handoff } = generatedHandoff(fixture, skill);
        assert.match(fixture.instructions, /Missing prior focused execution evidence alone is not a finding or residual risk/u);
        assert.match(fixture.instructions, /exactly one relevant authenticated repository target/u);
        assert.match(fixture.instructions, /reserved F-000 only with the exact evidence-only marker and target required by the generated handoff/u);
        assert.match(handoff.promptTemplateArtifactText, /F-000/u);
        assert.match(handoff.rolePromptArtifactText, /\[garda:evidence-only:missing-focused-validation\]/u);
    }
});

test('test strategy and its materialized checklist retain distinct-failure overlap and accountable quarantine', context => {
    const fixture = materializeSkill(context, SKILLS[1]);
    const checklist = fs.readFileSync(path.join(fixture.skillRoot, 'references', 'checklist.md'), 'utf8');
    for (const instructions of [fixture.instructions, checklist]) {
        assert.match(instructions, /repeated assertions across layers.*distinct failure modes/u);
        assert.match(instructions, /tracked repair or replacement.*accountable owner and exit condition.*retained critical signal/u);
        assert.match(instructions, /intended behavior.*old behavior fails/u);
        assert.doesNotMatch(instructions, /Do not duplicate assertions across layers|quarantine known-flaky tests instead of skipping them silently/u);
    }
});

test('infra implementation advice cannot authorize mandatory-review commands or platform claims', context => {
    const fixture = materializeSkill(context, SKILLS[2]);
    assert.match(fixture.instructions, /mandatory reviewer, never run Garda, edit source, deploy\/apply resources, access live infrastructure or credentials, or run Terraform plan/u);
    assert.match(fixture.instructions, /checklist below never grant command authority/u);
    assert.match(fixture.instructions, /Only the separately authorized implementation executor may select and run infrastructure commands/u);
    assert.doesNotMatch(fixture.instructions, /Execute the actual lint\/template\/validate\/plan commands from/u);
    assert.match(fixture.instructions, /Distinguish|distinguish.*unperformed validation recommendation/u);
});
