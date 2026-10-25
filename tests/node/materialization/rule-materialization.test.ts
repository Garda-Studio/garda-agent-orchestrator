import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    RULE_FILES,
    OPTIONAL_RULE_SUPPORT_FILES,
    CONTEXT_RULE_FILES,
    GENERATED_RULE_FILES,
    selectRuleSource,
    selectRuleSources,
    applyContextDefaults,
    applyAssistantDefaults,
    generateProjectMemorySummary,
    extractNonEmptySections,
    stripHtmlComments
} from '../../../src/materialization/rule-materialization';
import {
    PROJECT_MEMORY_MAP_READ_GUIDANCE,
    PROJECT_MEMORY_MAP_WRITE_CONTRACT
} from '../../../src/core/project-memory';
import { parseProjectValidationContract } from '../../../src/core/project-validation-recipes';

function findRepoRoot() {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'template')) && fs.existsSync(path.join(current, 'package.json'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root.');
}

describe('expected-RED operator guidance', () => {
    it('materializes explicit approval and stale RED exits in both workflow rules', () => {
        const repoRoot = findRepoRoot();
        for (const name of ['40-commands.md', '80-task-workflow.md']) {
            const source = selectRuleSources(name, {
                targetRoot: repoRoot,
                templateRuleRoot: path.join(repoRoot, 'template/docs/agent-rules'),
                liveRuleRoot: path.join(repoRoot, 'live/docs/agent-rules')
            }).find(candidate => candidate.origin === 'template');
            assert.ok(source);
            const rule = fs.readFileSync(source.path, 'utf8').replace(/\s+/gu, ' ');
            assert.match(rule, /only after explicit operator approval/u);
            assert.match(rule, /Changing a test after its RED was recorded.*invalidates that RED/u);
            assert.match(rule, /fresh RED for the current test bytes/u);
            assert.match(rule, /with operator approval remove.*Test-first: expected-red/u);
            assert.match(rule, /tests, compile, full suite and every required review remain mandatory/u);
            assert.match(rule, /Do not use.*task-reset.*for this/u);
        }
    });
});

describe('review catalog materialization contracts', () => {
    it('publishes a parseable v1 declaration and offers governed recipe safety guidance', () => {
        const repoRoot = findRepoRoot();
        const guide = fs.readFileSync(path.join(repoRoot, 'docs/project-validation-recipes.md'), 'utf8');
        const example = guide.match(/```json\r?\n([\s\S]*?)\r?\n```/u);
        assert.ok(example, 'guide must contain the complete declaration shape');
        const contract = parseProjectValidationContract(JSON.parse(example[1]));
        const recipe = contract.recipes[0];
        assert.equal(recipe.purpose, 'test');
        assert.equal(recipe.result_format, 'tap');
        assert.equal(recipe.max_attempts, 1);
        assert.ok(recipe.inputs.some(input => input.role === 'source'));
        assert.ok(recipe.inputs.some(input => input.role === 'test'));
        assert.equal(recipe.targets[0].selector, 'прибавление一');
        const source = selectRuleSources('70-security.md', {
            targetRoot: repoRoot,
            templateRuleRoot: path.join(repoRoot, 'template/docs/agent-rules'),
            liveRuleRoot: path.join(repoRoot, 'live/docs/agent-rules')
        }).find(candidate => candidate.origin === 'template');
        assert.equal(source?.origin, 'template');
        const rule = fs.readFileSync(source!.path, 'utf8');
        assert.ok(rule.includes('## Project Validation Recipes'));
        assert.ok(rule.includes('UNRESOLVED'));
        assert.ok(rule.includes('independent semantic review'));
    });

    it('keeps canonical task, skill, and provider guidance compact and legacy-compatible', () => {
        const repoRoot = findRepoRoot();
        const taskWorkflow = fs.readFileSync(
            path.join(repoRoot, 'template', 'docs', 'agent-rules', '80-task-workflow.md'),
            'utf8'
        );
        const skillCatalog = fs.readFileSync(
            path.join(repoRoot, 'template', 'docs', 'agent-rules', '90-skill-catalog.md'),
            'utf8'
        );
        const providerIndex = fs.readFileSync(
            path.join(repoRoot, 'template', 'entrypoints', 'canonical-rule-index.md'),
            'utf8'
        );

        for (const marker of [
            '## Review Catalog Context Contract',
            'Built-in review lanes and their canonical verdict tokens remain compatibility-owned',
            'Custom review lanes are declarative and disabled by default',
            'immutable current-task catalog/policy snapshot',
            'Do not load `live/config/review-catalog.json` into normal task or reviewer context',
            '`review-catalog list|show|explain|validate`'
        ]) {
            assert.ok(taskWorkflow.includes(marker), `task workflow should include ${marker}`);
        }
        assert.ok(skillCatalog.includes('absence remains compatible with the built-in review lanes'));
        assert.ok(skillCatalog.includes('Do not read the complete review catalog'));
        assert.ok(providerIndex.includes('immutable current-task review snapshot'));
        assert.ok(providerIndex.includes('must not load the full optional `review-catalog.json`'));
    });
});

describe('RULE_FILES', () => {
    it('contains all 12 standard rule files', () => {
        assert.equal(RULE_FILES.length, 12);
        assert.ok(RULE_FILES.includes('00-core.md'));
        assert.ok(RULE_FILES.includes('15-project-memory.md'));
        assert.ok(RULE_FILES.includes('40-commands.md'));
        assert.ok(RULE_FILES.includes('80-task-workflow.md'));
        assert.ok(RULE_FILES.includes('90-skill-catalog.md'));
        assert.ok(!RULE_FILES.includes('40-command-reference.md'));
    });

    it('keeps command reference appendix outside mandatory rule files', () => {
        assert.deepEqual(OPTIONAL_RULE_SUPPORT_FILES, ['40-command-reference.md']);
        assert.ok(!RULE_FILES.includes(OPTIONAL_RULE_SUPPORT_FILES[0]));
    });

    it('skill catalogs list all baseline skills used by orchestration', () => {
        const repoRoot = findRepoRoot();
        const requiredSkills = [
            'orchestration',
            'orchestration-depth1',
            'code-review',
            'db-review',
            'dependency-review',
            'security-review',
            'refactor-review',
            'skill-builder'
        ];

        for (const relativePath of [
            'template/docs/agent-rules/90-skill-catalog.md',
            'live/docs/agent-rules/90-skill-catalog.md'
        ]) {
            const fullPath = path.join(repoRoot, relativePath);
            if (!fs.existsSync(fullPath)) {
                continue;
            }
            const content = fs.readFileSync(fullPath, 'utf8');
            for (const skillId of requiredSkills) {
                assert.ok(
                    content.includes(`garda-agent-orchestrator/live/skills/${skillId}`),
                    `${relativePath} should list ${skillId}`
                );
            }
        }
    });
});

describe('GENERATED_RULE_FILES', () => {
    it('contains 15-project-memory.md', () => {
        assert.equal(GENERATED_RULE_FILES.length, 1);
        assert.ok(GENERATED_RULE_FILES.includes('15-project-memory.md'));
    });

    it('is a subset of RULE_FILES', () => {
        for (const f of GENERATED_RULE_FILES) {
            assert.ok(RULE_FILES.includes(f), `${f} should be in RULE_FILES`);
        }
    });
});

describe('CONTEXT_RULE_FILES', () => {
    it('contains the 6 context rules', () => {
        assert.equal(CONTEXT_RULE_FILES.length, 6);
        assert.ok(CONTEXT_RULE_FILES.includes('10-project-context.md'));
        assert.ok(CONTEXT_RULE_FILES.includes('60-operating-rules.md'));
    });
});

describe('selectRuleSource', () => {
    it('prefers template for 00-core.md', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rules-'));
        try {
            const templateRuleRoot = path.join(tmpDir, 'template');
            const liveRuleRoot = path.join(tmpDir, 'live');
            const targetRoot = path.join(tmpDir, 'project');
            fs.mkdirSync(templateRuleRoot, { recursive: true });
            fs.mkdirSync(liveRuleRoot, { recursive: true });
            fs.mkdirSync(path.join(targetRoot, 'docs/agent-rules'), { recursive: true });
            fs.writeFileSync(path.join(templateRuleRoot, '00-core.md'), 'template');
            fs.writeFileSync(path.join(liveRuleRoot, '00-core.md'), 'live');
            fs.writeFileSync(path.join(targetRoot, 'docs/agent-rules/00-core.md'), 'legacy');

            const result = selectRuleSource('00-core.md', { targetRoot, liveRuleRoot, templateRuleRoot });
            assert.equal(result!.origin, 'template');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prefers legacy for context rules', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rules-ctx-'));
        try {
            const templateRuleRoot = path.join(tmpDir, 'template');
            const liveRuleRoot = path.join(tmpDir, 'live');
            const targetRoot = path.join(tmpDir, 'project');
            fs.mkdirSync(templateRuleRoot, { recursive: true });
            fs.mkdirSync(liveRuleRoot, { recursive: true });
            fs.mkdirSync(path.join(targetRoot, 'docs/agent-rules'), { recursive: true });
            fs.writeFileSync(path.join(templateRuleRoot, '10-project-context.md'), 'template');
            fs.writeFileSync(path.join(liveRuleRoot, '10-project-context.md'), 'live');
            fs.writeFileSync(path.join(targetRoot, 'docs/agent-rules/10-project-context.md'), 'legacy');

            const result = selectRuleSource('10-project-context.md', { targetRoot, liveRuleRoot, templateRuleRoot });
            assert.equal(result!.origin, 'legacy-docs');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('prefers live for non-context, non-core rules', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rules-live-'));
        try {
            const templateRuleRoot = path.join(tmpDir, 'template');
            const liveRuleRoot = path.join(tmpDir, 'live');
            const targetRoot = path.join(tmpDir, 'project');
            fs.mkdirSync(templateRuleRoot, { recursive: true });
            fs.mkdirSync(liveRuleRoot, { recursive: true });
            fs.writeFileSync(path.join(templateRuleRoot, '70-security.md'), 'template');
            fs.writeFileSync(path.join(liveRuleRoot, '70-security.md'), 'live');

            const result = selectRuleSource('70-security.md', { targetRoot, liveRuleRoot, templateRuleRoot });
            assert.equal(result!.origin, 'live-existing');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('returns null when no source found', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rules-none-'));
        try {
            const result = selectRuleSource('missing.md', {
                targetRoot: tmpDir,
                liveRuleRoot: path.join(tmpDir, 'live'),
                templateRuleRoot: path.join(tmpDir, 'template')
            });
            assert.equal(result, null);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('skips obsolete legacy bootstrap code-style and falls through to live-existing', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-rules-style-'));
        try {
            const templateRuleRoot = path.join(tmpDir, 'template');
            const liveRuleRoot = path.join(tmpDir, 'live');
            const targetRoot = path.join(tmpDir, 'project');
            fs.mkdirSync(templateRuleRoot, { recursive: true });
            fs.mkdirSync(liveRuleRoot, { recursive: true });
            fs.mkdirSync(path.join(targetRoot, 'docs/agent-rules'), { recursive: true });

            const templateContent = fs.readFileSync(
                path.join(findRepoRoot(), 'template', 'docs', 'agent-rules', '30-code-style.md'),
                'utf8'
            );
            const legacyBootstrapContent = [
                '# Code Style',
                '',
                '## Bootstrap Policy When Repository Is Empty',
                '- Keep the legacy bootstrap default for empty repositories.',
                '',
                '## Language-Specific Rules (Fill Only Relevant Sections)',
                '- Type strictness level and runtime validation strategy: `TODO`'
            ].join('\n');
            const liveContent = '# Code Style\n\n## Naming\n- Prefer intent-first helper names.\n';

            fs.writeFileSync(path.join(templateRuleRoot, '30-code-style.md'), templateContent, 'utf8');
            fs.writeFileSync(path.join(liveRuleRoot, '30-code-style.md'), liveContent, 'utf8');
            fs.writeFileSync(path.join(targetRoot, 'docs/agent-rules/30-code-style.md'), legacyBootstrapContent, 'utf8');

            const result = selectRuleSource('30-code-style.md', { targetRoot, liveRuleRoot, templateRuleRoot });
            assert.equal(result!.origin, 'live-existing');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('applyContextDefaults', () => {
    it('appends discovery overlay to context rules', () => {
        const content = '# 10-project-context\n\nSome content.';
        const overlay = '## Project Discovery Snapshot\n- Stacks: Node.js';
        const result = applyContextDefaults(content, '10-project-context.md', overlay);
        assert.ok(result!.includes('Project Discovery Snapshot'));
        assert.ok(result!.includes('Some content'));
    });

    it('does not modify non-context rules', () => {
        const content = '# Security rules\n\nContent.';
        const result = applyContextDefaults(content, '70-security.md', 'overlay');
        assert.equal(result, content);
    });

    it('replaces existing overlay section', () => {
        const content = '# Context\n\n## Project Discovery Snapshot\n- Old data\n\n## Other Section';
        const overlay = '## Project Discovery Snapshot\n- New data';
        const result = applyContextDefaults(content, '10-project-context.md', overlay);
        assert.ok(result!.includes('New data'));
    });

    it('replaces a final overlay section completely, leaving no stale snapshot data', () => {
        const content = '# Commands\n\n## Project Discovery Snapshot\n- Files considered: 515\n'
            + '- Detected stacks: Node.js or JavaScript, TypeScript\n- Full report: `live/project-discovery.md`\n';
        const overlay = '## Project Discovery Snapshot\n- Detected stacks: Go';
        const result = applyContextDefaults(content, '40-commands.md', overlay)!;
        assert.equal(result.match(/## Project Discovery Snapshot/gu)?.length, 1);
        assert.ok(result.includes('Detected stacks: Go'));
        assert.ok(!result.includes('Files considered: 515'));
        assert.ok(!result.includes('Node.js or JavaScript'));
    });
});

describe('applyAssistantDefaults', () => {
    it('replaces placeholders in 00-core.md', () => {
        const content = [
            '{{ASSISTANT_RESPONSE_LANGUAGE}}',
            '{{ASSISTANT_RESPONSE_BREVITY}}',
            'Respond in English for explanations and assistance.',
            '1. Respond in English.',
            'Default response brevity: concise.',
            '2. Keep responses concise unless the user explicitly asks for more or less detail.'
        ].join('\n');

        const result = applyAssistantDefaults(content, '00-core.md', 'Russian', 'detailed');
        assert.ok(result!.includes('Russian'));
        assert.ok(result!.includes('detailed'));
        assert.ok(!result.includes('{{ASSISTANT_RESPONSE_LANGUAGE}}'));
        assert.ok(!result.includes('{{ASSISTANT_RESPONSE_BREVITY}}'));
        assert.ok(result!.includes('Respond in Russian for explanations and assistance.'));
        assert.ok(result!.includes('Default response brevity: detailed.'));
    });

    it('does not modify non-core rules', () => {
        const content = '{{ASSISTANT_RESPONSE_LANGUAGE}}';
        const result = applyAssistantDefaults(content, '10-project-context.md', 'Russian', 'detailed');
        assert.equal(result, content);
    });
});

describe('stripHtmlComments', () => {
    it('removes single-line comments', () => {
        assert.equal(stripHtmlComments('before <!-- comment --> after'), 'before  after');
    });

    it('removes multi-line comments', () => {
        assert.equal(stripHtmlComments('a\n<!-- line1\nline2 -->\nb').trim(), 'a\n\nb');
    });

    it('returns text unchanged when no comments', () => {
        assert.equal(stripHtmlComments('plain text'), 'plain text');
    });
});

describe('extractNonEmptySections', () => {
    it('extracts sections with real content', () => {
        const md = [
            '# Title',
            '',
            '## Domain',
            '',
            'E-commerce platform.',
            '',
            '## Goals',
            '',
            '<!-- placeholder -->',
            ''
        ].join('\n');

        const sections = extractNonEmptySections(md);
        assert.equal(sections.length, 1);
        assert.equal(sections[0].heading, 'Domain');
        assert.equal(sections[0].content, 'E-commerce platform.');
    });

    it('skips sections with only HTML comments', () => {
        const md = '## Empty\n\n<!-- just a hint -->\n\n## Also Empty\n<!-- another -->';
        const sections = extractNonEmptySections(md);
        assert.equal(sections.length, 0);
    });

    it('handles multiple populated sections', () => {
        const md = '## A\nContent A\n## B\nContent B\n';
        const sections = extractNonEmptySections(md);
        assert.equal(sections.length, 2);
        assert.equal(sections[0].heading, 'A');
        assert.equal(sections[1].heading, 'B');
    });
});

describe('generateProjectMemorySummary', () => {
    it('generates stub when directory does not exist', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-absent-'));
        try {
            const result = generateProjectMemorySummary(
                path.join(tmpDir, 'nonexistent'), '2025-01-01T00:00:00.000Z'
            );
            assert.ok(result!.includes('DO NOT EDIT'));
            assert.ok(result!.includes('15 · Project Memory Summary'));
            assert.ok(result!.includes('No `docs/project-memory/` directory found'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('generates stub when directory has no .md files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-empty-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result!.includes('DO NOT EDIT'));
            assert.ok(result!.includes('contains no content files yet'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('generates stub when all files have only placeholder content', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-placeholders-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Context\n\n## Domain\n\n<!-- placeholder -->\n', 'utf8');

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result!.includes('DO NOT EDIT'));
            assert.ok(result!.includes('only placeholder templates'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('generates bounded link-first summary with content highlights and provenance hashes', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-full-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Context\n\n## Domain\n\nE-commerce SaaS.\n\n## Goals\n\nScale globally.\n', 'utf8');
            fs.writeFileSync(path.join(pmDir, 'stack.md'),
                '# Stack\n\n## Languages\n\nTypeScript 5.x, Python 3.12.\n', 'utf8');

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result!.includes('DO NOT EDIT'));
            assert.ok(result!.includes('2025-01-01T00:00:00.000Z'));
            assert.ok(result!.includes('link-first orientation index'));
            assert.ok(result!.includes('## Map Contract'));
            assert.ok(result!.includes(PROJECT_MEMORY_MAP_READ_GUIDANCE));
            assert.ok(result!.includes(PROJECT_MEMORY_MAP_WRITE_CONTRACT));
            assert.ok(result!.includes('## Source Index'));
            assert.ok(result!.includes('### `context.md`'));
            assert.ok(result!.includes('E-commerce SaaS.'));
            assert.ok(result!.includes('Goals: Scale globally.'));
            assert.ok(result!.includes('Scale globally.'));
            assert.ok(result!.includes('### `stack.md`'));
            assert.ok(result!.includes('TypeScript 5.x'));
            assert.ok(result!.includes('## Provenance'));
            assert.match(
                result,
                /\| `context\.md` \| `docs\/project-memory\/context\.md` \| `[a-f0-9]{64}` \| content \|/
            );
            assert.match(
                result,
                /\| `stack\.md` \| `docs\/project-memory\/stack\.md` \| `[a-f0-9]{64}` \| content \|/
            );
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('hides task-id headings from the generated map while preserving a warning', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-task-heading-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'decisions.md'),
                [
                    '# Decisions',
                    '',
                    '## T-737',
                    '',
                    'One-off task narrative that should not define map structure.',
                    '',
                    '## Review Workflow',
                    '',
                    'Delegated reviewers must run in fresh context.'
                ].join('\n'), 'utf8');

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result.includes('Review Workflow'));
            assert.ok(result.includes('1 task-id provenance heading(s) hidden'));
            assert.ok(result.includes('Task-id headings detected in source memory'));
            assert.ok(!result.includes('- T-737:'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('includes README.md as a read-first source instead of dropping project-memory index files', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-readme-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'README.md'),
                '# Project Memory\n\n## Ownership Contract\n\nUser-owned.\n', 'utf8');

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result.includes('docs/project-memory/README.md'));
            assert.ok(result.includes('Read Order'));
            assert.ok(result.includes('## Provenance'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('regenerates with updated content', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-regen-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Context\n\n## Domain\n\nVersion 1.\n', 'utf8');

            const result1 = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result1.includes('Version 1.'));

            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Context\n\n## Domain\n\nVersion 2.\n', 'utf8');

            const result2 = generateProjectMemorySummary(pmDir, '2025-01-02T00:00:00.000Z');
            assert.ok(result2.includes('Version 2.'));
            assert.ok(!result2.includes('Version 1.'));
            assert.ok(result2.includes('2025-01-02'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('sorts files alphabetically for deterministic output', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-sort-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'z-last.md'),
                '# Z\n\n## Z Section\n\nZ content.\n', 'utf8');
            fs.writeFileSync(path.join(pmDir, 'a-first.md'),
                '# A\n\n## A Section\n\nA content.\n', 'utf8');

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            const aIdx = result.indexOf('### `a-first.md`');
            const zIdx = result.indexOf('### `z-last.md`');
            assert.ok(aIdx < zIdx, 'a-first.md should appear before z-last.md');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does not duplicate large project-memory bodies into generated summary', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-bounded-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            const repeatedDetails = Array.from({ length: 200 }, (_value, index) => `Detail ${index}: verbose architecture fact`).join('\n');
            fs.writeFileSync(path.join(pmDir, 'architecture.md'),
                `# Architecture\n\n## Runtime\n\nFirst durable line.\n${repeatedDetails}\n`, 'utf8');

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result.includes('First durable line.'));
            assert.ok(!result.includes('Detail 199: verbose architecture fact'));
            assert.ok(result.length < 12000, 'generated summary should stay bounded by previewing content');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('treats meaningful content outside H2 sections as content in generated summary', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-h1-content-'));
        try {
            const pmDir = path.join(tmpDir, 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'custom.md'),
                '# Custom Memory\n\nImportant durable fact outside a level-2 section.\n', 'utf8');

            const result = generateProjectMemorySummary(pmDir, '2025-01-01T00:00:00.000Z');
            assert.ok(result.includes('| `docs/project-memory/custom.md` | Custom durable project-memory file. | content |'));
            assert.ok(result.includes('### `custom.md`'));
            assert.ok(result.includes('Important durable fact outside a level-2 section.'));
            assert.ok(!result.includes('| `custom.md` | `docs/project-memory/custom.md` | `n/a` | placeholder_only |'));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('literal dollar text in generated content', () => {
    it('keeps $&, $` and $\' literally when replacing the discovery snapshot', () => {
        const content = '# Commands\n\n## Project Discovery Snapshot\n- Old data\n';
        const overlay = '## Project Discovery Snapshot\n- Command: echo "$&" "$`" "$\'" "$1"';
        const result = applyContextDefaults(content, '40-commands.md', overlay)!;
        assert.ok(result.includes('- Command: echo "$&" "$`" "$\'" "$1"'));
        assert.ok(!result.includes('Old data'));
    });
});

describe('discovery snapshot upgrade from earlier releases', () => {
    it('removes every earlier snapshot and preserves the following subsection', () => {
        const content = [
            '# Commands', '', '## Project Discovery Snapshot', '- Discovery source: git_index_and_worktree',
            '- Files considered: 515', '- Detected stacks: Node.js or JavaScript, TypeScript', '',
            '## Project Discovery Snapshot', '- Files considered: 5', '- Detected stacks: Go', '',
            '### Manual Validation Evidence Selector', 'Keep this rule text.', '', '## Later Section', 'tail'
        ].join('\r\n');
        const overlay = '## Project Discovery Snapshot\r\n- Detected stacks: Go\r\n- Files considered: 6';
        const result = applyContextDefaults(content, '40-commands.md', overlay)!;
        assert.equal(result.match(/## Project Discovery Snapshot/gu)?.length, 1);
        assert.ok(!result.includes('Files considered: 515'));
        assert.ok(!result.includes('Node.js or JavaScript'));
        assert.ok(result.includes('- Files considered: 6'));
        assert.ok(result.includes('### Manual Validation Evidence Selector\r\nKeep this rule text.'));
        assert.ok(result.indexOf('Files considered: 6') < result.indexOf('### Manual Validation Evidence Selector'));
        assert.ok(result.includes('## Later Section\r\ntail'));
    });
});
