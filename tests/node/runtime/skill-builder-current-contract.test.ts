import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRepoRoot } from '../../../scripts/node-foundation/build';
import { readBaselineSkillManifest } from '../../../src/runtime/skill-manifest';
import { buildReviewCoverageContract } from '../../../src/gates/review/review-coverage-ledger';
import { buildReviewerFindingsOutputTemplateJson } from '../../../src/gates/review/reviewer-findings-prompt-contract';
import { handleReviewCatalog } from '../../../src/cli/commands/review-catalog-command';

test('builder example is a valid installed specialist with a generated findings-only output contract', t => {
    const source = path.join(getRepoRoot(), 'template/skills/skill-builder');
    const example = fs.readFileSync(path.join(source, 'references/skill-template.md'), 'utf8');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-builder-contract-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifest = JSON.parse(example.match(/```json\n([\s\S]+?)\n```/u)![1]);
    const instructions = example.match(/```md\n([\s\S]+?)\n```/u)![1];
    fs.mkdirSync(path.join(root, 'references'));
    fs.writeFileSync(path.join(root, 'skill.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(root, 'SKILL.md'), instructions);
    fs.writeFileSync(path.join(root, 'references/checklist.md'), example.split('## `references/checklist.md`')[1].split('## Declarative lane example')[0]);
    assert.equal(readBaselineSkillManifest(root).id, 'contract-specialist');
    const coverageContract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: ['src/example.ts'] });
    const output = JSON.parse(buildReviewerFindingsOutputTemplateJson({ taskId: 'T-EXAMPLE', reviewType: 'code',
        reviewContextSha256: 'a'.repeat(64), treeStateSha256: 'b'.repeat(64), coverageContract }));
    for (const key of ['verdict', 'status', 'disposition', 'remediation']) assert.equal(Object.hasOwn(output, key), false);
    assert.match(instructions, /sole instruction and output-format authority/);
    assert.match(instructions, /Write only the exact\nReviewOutputPath/);
    assert.match(example, /review-catalog create contract-check .*--trigger-mode manual/);
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const configDir = path.join(bundleRoot, 'live/config');
    fs.mkdirSync(configDir, { recursive: true });
    const installedSkill = path.join(bundleRoot, 'live/skills/contract-specialist');
    fs.mkdirSync(installedSkill, { recursive: true });
    fs.writeFileSync(path.join(installedSkill, 'skill.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(installedSkill, 'SKILL.md'), instructions);
    for (const name of ['profiles.json', 'review-capabilities.json', 'workflow-config.json']) {
        fs.copyFileSync(path.join(getRepoRoot(), 'template/config', name), path.join(configDir, name));
    }
    const beforeConfig = fs.readdirSync(configDir).map(name => [name, fs.readFileSync(path.join(configDir, name), 'utf8')]);
    const command = example.match(/^garda review-catalog (.+)$/mu)![1];
    const args = command.match(/"[^"]*"|\S+/gu)!.map(value => value.replace(/^"|"$/gu, ''));
    args[args.indexOf('--target-root') + 1] = root;
    const messages: string[] = [];
    t.mock.method(console, 'log', (...values: unknown[]) => messages.push(values.join(' ')));
    const preview = handleReviewCatalog([...args, '--bundle-root', bundleRoot, '--json'], { name: 'garda-agent-orchestrator', version: '1.0.0' }) as Record<string, unknown>;
    t.mock.restoreAll();
    assert.equal(preview.action, 'create');
    assert.equal(preview.mode, 'preview');
    assert.equal(preview.status, 'PREVIEW');
    assert.equal(preview.review_id, 'contract-check');
    assert.equal(preview.changed, true);
    assert.deepEqual(fs.readdirSync(configDir).map(name => [name, fs.readFileSync(path.join(configDir, name), 'utf8')]), beforeConfig);
    for (const file of ['SKILL.md', 'references/wiring-checklist.md', 'references/authoring-principles.md']) {
        const text = fs.readFileSync(path.join(source, file), 'utf8');
        assert.doesNotMatch(text, /<Key>ReviewVerdict|set `true` for supported|custom and unsupported by gate scripts/);
    }
    const wiring = fs.readFileSync(path.join(source, 'references/wiring-checklist.md'), 'utf8');
    assert.match(wiring, /preview-only/);
    assert.match(wiring, /one-time receipt/);
    assert.match(wiring, /future task snapshots/);
});
