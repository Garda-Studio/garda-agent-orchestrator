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

type Example = Record<string, unknown>;

const SKILL_ROOT = path.join(getRepoRoot(), 'template', 'skill-packs', 'quality-architecture', 'skills', 'api-contract-review');
const instructions = fs.readFileSync(path.join(SKILL_ROOT, 'SKILL.md'), 'utf8');

function readExamples(heading: string): Example[] {
    const marker = `### ${heading}\n`;
    const headingStart = instructions.indexOf(marker);
    assert.notEqual(headingStart, -1);
    const start = headingStart + marker.length;
    const nextHeading = instructions.indexOf('\n##', start);
    const section = instructions.slice(start, nextHeading === -1 ? undefined : nextHeading);
    return [...section.matchAll(/```json\n([\s\S]*?)\n```/gu)]
        .map(match => JSON.parse(match[1]) as Example);
}

function readOldResponse(value: Example, field = 'state'): string {
    if (Object.keys(value).some(key => key !== field)) throw new Error('Unknown response field.');
    if (!['queued', 'done'].includes(String(value[field]))) throw new Error('Unknown response state.');
    return String(value[field]);
}

function readNewConfig(value: Example): number {
    if (typeof value.retryLimit !== 'number') throw new Error('retryLimit is required.');
    return value.retryLimit;
}

function materializeSkill(context: TestContext) {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-api-directional-'));
    context.after(() => {
        assert.equal(path.dirname(bundleRoot), path.resolve(os.tmpdir()));
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    });
    const skillRoot = path.join(bundleRoot, 'live', 'skills', 'api-contract-review');
    const customPath = path.join(bundleRoot, 'live', 'skills', 'project-specialist', 'SKILL.md');
    fs.mkdirSync(path.dirname(customPath), { recursive: true });
    fs.writeFileSync(customPath, '# Project-owned specialist\n', 'utf8');
    copyDirectoryRecursive(SKILL_ROOT, skillRoot, { destinationRoot: bundleRoot });
    for (const file of ['SKILL.md', 'skill.json', 'references/checklist.md']) {
        assert.deepEqual(fs.readFileSync(path.join(skillRoot, file)), fs.readFileSync(path.join(SKILL_ROOT, file)));
    }
    assert.equal(fs.readFileSync(customPath, 'utf8'), '# Project-owned specialist\n');
    return { bundleRoot, skillRoot };
}

test('response enum expansion breaks an old strict decoder while emitted narrowing remains decodable', () => {
    const [expandedResponse] = readExamples('Response enum expansion');
    assert.throws(() => readOldResponse(expandedResponse), /Unknown response state/u);
    assert.equal(readOldResponse({ state: 'done' }), 'done');
    assert.match(instructions, /smaller emitted set can remain decodable by old readers/u);
    assert.match(instructions, /new narrower reader may reject values from an old producer/u);
});

test('request enum expansion preserves old callers without promising reverse rollout compatibility', () => {
    const [oldRead, oldWrite, newAppend] = readExamples('Request enum expansion');
    const oldServer = new Set(['read', 'write']);
    const newServer = new Set(['read', 'write', 'append']);
    assert.ok(oldServer.has(String(oldRead.mode)));
    assert.ok(oldServer.has(String(oldWrite.mode)));
    assert.ok(newServer.has(String(oldRead.mode)));
    assert.ok(newServer.has(String(oldWrite.mode)));
    assert.ok(newServer.has(String(newAppend.mode)));
    assert.equal(oldServer.has(String(newAppend.mode)), false);
    assert.match(instructions, /does not guarantee that the old server accepts the new caller/u);
});

test('old persisted config needs an actual applied default or migration rather than a default annotation', () => {
    const [oldConfig, migratedConfig] = readExamples('Persisted config and CLI readers');
    const annotatedSchema = { retryLimit: { default: 3 } };
    assert.equal(annotatedSchema.retryLimit.default, 3);
    assert.throws(() => readNewConfig(oldConfig), /retryLimit is required/u);
    assert.equal(Object.hasOwn(oldConfig, 'retryLimit'), false);
    assert.equal(readNewConfig(migratedConfig), 3);
    assert.equal(readNewConfig({ ...oldConfig, retryLimit: annotatedSchema.retryLimit.default }), 3);
});

test('CLI emitted enum expansion can break an independently versioned machine reader', () => {
    const [, , cliOutput] = readExamples('Persisted config and CLI readers');
    assert.throws(() => readOldResponse(cliOutput, 'phase'), /Unknown response state/u);
    assert.equal(readOldResponse({ phase: 'queued' }, 'phase'), 'queued');
    assert.match(instructions, /CLI arguments, review accepted input/u);
    assert.match(instructions, /CLI JSON or other machine output, review emitted output/u);
});

test('nullability defaults and unknown fields are checked by direction and observable semantics', () => {
    assert.throws(() => readOldResponse({ state: null }), /Unknown response state/u);
    assert.throws(() => readOldResponse({ state: 'queued', added: true }), /Unknown response field/u);
    const requestDefault = (input: Example, defaultMode: string) => input.mode ?? defaultMode;
    assert.notEqual(requestDefault({}, 'read'), requestDefault({}, 'write'));
    assert.match(instructions, /Accepting null adds input capability; rejecting previously accepted null/u);
    assert.match(instructions, /Newly emitting null can break an old non-null reader/u);
    assert.match(instructions, /schema default annotation need not insert a value/u);
    assert.match(instructions, /Adding even an optional field can break readers that reject unknown fields/u);
});

test('error changes retain project conventions and evidence-based impact without an automatic version bump', () => {
    const oldErrorCodes = new Set(['invalid-input']);
    assert.equal(oldErrorCodes.has('retry-exhausted'), false);
    assert.match(instructions, /New error codes, shapes or status meanings can break old error decoders/u);
    assert.match(instructions, /existing versioning, deprecation, migration and error conventions/u);
    assert.match(instructions, /Uncertainty alone does not justify an automatic version bump/u);
    assert.match(instructions, /Severity follows demonstrated failure, exposure and project impact/u);
    assert.doesNotMatch(instructions, /When uncertain, treat the change as breaking|inconsistent error envelopes are a high-severity finding/u);
});

test('API reviewer materializes directional guidance compatible with its generated findings-only handoff', context => {
    const { bundleRoot, skillRoot } = materializeSkill(context);
    const manifest = readBaselineSkillManifest(skillRoot);
    assert.equal(manifest.id, 'api-contract-review');
    assert.deepEqual(manifest.references, ['checklist.md']);
    const materializedInstructions = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const checklist = fs.readFileSync(path.join(skillRoot, 'references', 'checklist.md'), 'utf8');
    assert.match(materializedInstructions, /sole instruction and output-format authority/u);
    assert.match(materializedInstructions, /only permitted write is the exact `ReviewOutputPath`/u);
    assert.match(materializedInstructions, /every coverage-ledger obligation/u);
    assert.match(materializedInstructions, /reserved F-000/u);
    assert.match(materializedInstructions, /advisory/u);
    assert.match(checklist, /Request-Consumer Compatibility/u);
    assert.match(checklist, /Response-Producer Compatibility/u);
    assert.match(checklist, /persisted JSON\/config, CLI arguments/u);
    assert.doesNotMatch(materializedInstructions, /API REVIEW PASSED|API REVIEW FAILED|## Verdict|## Deferred Findings|Justification:|Mandatory Output Format|historical audit-only guidance/u);
    assert.doesNotMatch(checklist, /No enum value removed from a response field|No type narrowing on existing request or response field/u);

    const skillPath = path.join(skillRoot, 'SKILL.md');
    const skillHash = stringSha256(materializedInstructions);
    const coverageContract = buildReviewCoverageContract({ reviewType: 'api', changedFiles: ['src/api-example.ts'] });
    const handoff = buildReviewContextHandoffArtifacts({
        reviewType: 'api',
        selectedSkill: {
            skill_id: manifest.id, skill_path: skillPath, skill_sha256: skillHash,
            skill_directory_path: skillRoot, skill_entrypoint_exists: true, candidate_skill_ids: [manifest.id]
        },
        paths: buildReviewContextHandoffArtifactPaths(path.join(bundleRoot, 'api-review-context.json')),
        ruleContextSections: { source_file_count: 0, summary: {}, source_files: [] },
        promptArtifactText: '# Assigned API review scope\n',
        stripExamplesApplied: false,
        stripCodeBlocksApplied: false,
        coverageContract
    });
    assert.equal(handoff.reviewerHandoff.role_prompt.selected_skill.skill_sha256, skillHash);
    assert.match(handoff.rolePromptArtifactText, /generated prompt and output-template artifacts are the sole output-format authority/u);
    assert.match(handoff.promptTemplateArtifactText, /F-000/u);
    const jsonStart = handoff.outputTemplateArtifactText.indexOf('\n{');
    assert.notEqual(jsonStart, -1);
    const form = JSON.parse(handoff.outputTemplateArtifactText.slice(jsonStart + 1));
    assert.equal(form.review_type, 'api');
    assert.deepEqual(form.coverage_ledger.entries.map((entry: { obligation_id: string }) => entry.obligation_id),
        coverageContract.obligations.map(entry => entry.id));
    assert.deepEqual(Object.keys(form.findings), ['critical', 'high', 'medium', 'low']);
    for (const forbidden of ['verdict', 'status', 'disposition', 'remediation']) {
        assert.equal(Object.hasOwn(form, forbidden), false);
    }
});
