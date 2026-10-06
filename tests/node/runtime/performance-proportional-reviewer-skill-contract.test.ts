import test from 'node:test';
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

test('performance reviewer materializes proportional risk guidance compatible with its findings-only handoff', context => {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-performance-contract-'));
    context.after(() => {
        assert.equal(path.dirname(bundleRoot), path.resolve(os.tmpdir()));
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    });
    const sourceRoot = path.join(getRepoRoot(), 'template', 'skill-packs', 'quality-architecture', 'skills', 'performance-review');
    const skillRoot = path.join(bundleRoot, 'live', 'skills', 'performance-review');
    const customPath = path.join(bundleRoot, 'live', 'skills', 'project-specialist', 'SKILL.md');
    fs.mkdirSync(path.dirname(customPath), { recursive: true });
    fs.writeFileSync(customPath, '# Project-owned specialist\n', 'utf8');
    copyDirectoryRecursive(sourceRoot, skillRoot, { destinationRoot: bundleRoot });
    for (const relative of ['SKILL.md', 'skill.json', 'references/checklist.md']) {
        assert.deepEqual(fs.readFileSync(path.join(skillRoot, relative)), fs.readFileSync(path.join(sourceRoot, relative)));
    }
    assert.equal(fs.readFileSync(customPath, 'utf8'), '# Project-owned specialist\n');

    const instructions = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const checklist = fs.readFileSync(path.join(skillRoot, 'references', 'checklist.md'), 'utf8');
    const manifest = readBaselineSkillManifest(skillRoot);
    assert.equal(manifest.id, 'performance-review');
    assert.ok(manifest.references.includes('checklist.md'));
    assert.match(instructions, /sole instruction and output-format authority/u);
    assert.match(instructions, /only permitted write is the exact `ReviewOutputPath`/u);
    assert.match(instructions, /every coverage-ledger obligation/u);
    assert.match(instructions, /F-000/u);
    assert.match(instructions, /advisory/u);
    for (const text of [instructions, checklist]) {
        assert.doesNotMatch(text, /Every cache has a bounded TTL|caches without hit-rate observability|Flag sequential calls that could be parallelized/u);
        assert.doesNotMatch(text, /PERFORMANCE REVIEW PASSED|PERFORMANCE REVIEW FAILED|## Verdict|## Deferred Findings|Justification:|historical audit-only guidance/u);
        assert.match(text, /[Qq]uantitative.*before\/after/u);
    }

    function scenario(heading: string): string {
        const section = instructions.split(`### ${heading}\n`)[1];
        assert.ok(section, `Missing scenario: ${heading}`);
        return section.split(/\n#{2,3} /u)[0];
    }
    assert.match(scenario('Bounded Cache'), /64-entry cache with eviction and generation-based invalidation/u);
    assert.match(scenario('Bounded Cache'), /Missing TTL or hit-rate telemetry alone is not a finding/u);
    assert.match(scenario('Unbounded Growth'), /unique untrusted input without eviction or a bounded owner lifetime/u);
    assert.match(scenario('Unbounded Growth'), /Report the demonstrated retained growth and impact/u);
    assert.match(scenario('Measured Optimization Claim'), /20% latency reduction requires comparable before\/after measurements/u);
    assert.match(scenario('Measured Optimization Claim'), /unrelated descriptive changes do not inherit this requirement/u);
    assert.match(scenario('Intentionally Serial Mutations'), /Two writes in one transaction require order/u);
    assert.match(scenario('Intentionally Serial Mutations'), /Serial execution alone is not a performance defect/u);
    assert.match(checklist, /Capacity, eviction or owner lifetime bounds retained data/u);
    assert.match(checklist, /Intentionally serial mutations, transaction order and lock-protected shared resources retain their ordering/u);
    assert.match(checklist, /Concrete unbounded work, overload and correctness risks remain review findings/u);

    const skillPath = path.join(skillRoot, 'SKILL.md');
    const skillHash = stringSha256(instructions);
    const coverageContract = buildReviewCoverageContract({ reviewType: 'performance', changedFiles: ['src/cache-example.ts'] });
    const handoff = buildReviewContextHandoffArtifacts({
        reviewType: 'performance',
        selectedSkill: {
            skill_id: 'performance-review',
            skill_path: skillPath,
            skill_sha256: skillHash,
            skill_directory_path: skillRoot,
            skill_entrypoint_exists: true,
            candidate_skill_ids: ['performance-review']
        },
        paths: buildReviewContextHandoffArtifactPaths(path.join(bundleRoot, 'performance-review-context.json')),
        ruleContextSections: { source_file_count: 0, summary: {}, source_files: [] },
        promptArtifactText: '# Assigned performance review scope\n',
        stripExamplesApplied: false,
        stripCodeBlocksApplied: false,
        coverageContract
    });
    assert.equal(handoff.reviewerHandoff.role_prompt.selected_skill.skill_sha256, skillHash);
    assert.match(handoff.rolePromptArtifactText, /generated prompt and output-template artifacts are the sole output-format authority/u);
    assert.match(handoff.promptTemplateArtifactText, /F-000/u);
    const jsonStart = handoff.outputTemplateArtifactText.indexOf('\n{');
    assert.notEqual(jsonStart, -1);
    const output = JSON.parse(handoff.outputTemplateArtifactText.slice(jsonStart + 1));
    assert.equal(output.review_type, 'performance');
    assert.deepEqual(Object.keys(output.findings), ['critical', 'high', 'medium', 'low']);
    assert.deepEqual(output.coverage_ledger.entries.map((entry: { obligation_id: string }) => entry.obligation_id), coverageContract.obligations.map(entry => entry.id));
    for (const forbidden of ['verdict', 'status', 'disposition', 'remediation']) {
        assert.equal(Object.hasOwn(output, forbidden), false);
    }
});
