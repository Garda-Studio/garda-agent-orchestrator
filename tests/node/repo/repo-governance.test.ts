import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import {
    buildProviderOrchestratorAgentContent,
    buildSharedStartTaskWorkflowContent
} from '../../../src/materialization/content-builders';
import { runInit } from '../../../src/materialization/init';
import { runInstall } from '../../../src/materialization/install';

interface MaterializedWorkspace {
    projectRoot: string;
    bundleRoot: string;
}

let materializedWorkspace: MaterializedWorkspace | null = null;

function readRepoFile(relativePath: string): string {
    const repoRoot = getRepoRoot();
    const filePath = path.join(repoRoot, relativePath);
    assert.ok(fs.existsSync(filePath), `${relativePath} must exist`);
    return fs.readFileSync(filePath, 'utf8');
}

function readGeneratedRepoFile(relativePath: string): string {
    assert.ok(materializedWorkspace !== null, 'materialized workspace must be initialized before reading generated files');
    const filePath = path.join(materializedWorkspace.projectRoot, relativePath);
    assertRepoFileIgnoredAndNotTracked(relativePath);
    assert.ok(fs.existsSync(filePath), `${relativePath} must exist in the materialized repo surface`);
    return fs.readFileSync(filePath, 'utf8');
}

test('reviewer skills keep generated handoffs reviewer-only', () => {
    const reviewerSkillFiles = [
        'template/skills/code-review/SKILL.md',
        'template/skills/db-review/SKILL.md',
        'template/skills/dependency-review/SKILL.md',
        'template/skills/refactor-review/SKILL.md',
        'template/skills/security-review/SKILL.md',
        'template/skill-packs/devops-k8s/skills/devops-k8s/SKILL.md',
        'template/skill-packs/quality-architecture/skills/api-contract-review/SKILL.md',
        'template/skill-packs/quality-architecture/skills/performance-review/SKILL.md',
        'template/skill-packs/quality-architecture/skills/testing-strategy/SKILL.md'
    ];
    for (const relativePath of reviewerSkillFiles) {
        const content = readRepoFile(relativePath);
        assert.ok(content.includes('role-prompt, prompt-template, reviewer-prompt'), relativePath);
        assert.ok(content.includes('sole instruction and output-format authority'), relativePath);
        assert.ok(content.includes('Never modify source files, control artifacts, or task state'), relativePath);
        assert.ok(content.includes('never launch another agent'), relativePath);
        assert.ok(content.includes('only permitted write is the exact `ReviewOutputPath`'), relativePath);
    }
});

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMarkdownSection(content: string, heading: string): string {
    const headingMatch = heading.match(/^(#+)\s+/);
    assert.ok(headingMatch, `Heading must be markdown-formatted: ${heading}`);
    const headingLevel = headingMatch[1].length;
    const startPattern = new RegExp(`^${escapeRegExp(heading)}\\s*$`, 'm');
    const startMatch = startPattern.exec(content);
    assert.ok(startMatch, `Missing heading: ${heading}`);
    const sectionStart = startMatch.index;
    const searchStart = sectionStart + startMatch[0].length;
    const remainder = content.slice(searchStart);
    const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s+`, 'm');
    const nextHeadingMatch = nextHeadingPattern.exec(remainder);
    const sectionEnd = nextHeadingMatch
        ? searchStart + nextHeadingMatch.index
        : content.length;
    return content.slice(sectionStart, sectionEnd);
}

function assertRepoFileTrackedAndNotIgnored(relativePath: string): void {
    const repoRoot = getRepoRoot();
    const trackedResult = childProcess.spawnSync('git', ['ls-files', '--error-unmatch', relativePath], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(
        trackedResult.status,
        0,
        `${relativePath} must be tracked in git.\n${trackedResult.stderr || trackedResult.stdout}`
    );

    const ignoredResult = childProcess.spawnSync('git', ['check-ignore', relativePath], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.notEqual(
        ignoredResult.status,
        0,
        `${relativePath} must not be ignored by .gitignore.\n${ignoredResult.stdout || ignoredResult.stderr}`
    );
}

function assertRepoFileIgnoredAndNotTracked(relativePath: string): void {
    const repoRoot = getRepoRoot();
    const trackedResult = childProcess.spawnSync('git', ['ls-files', '--error-unmatch', relativePath], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.notEqual(
        trackedResult.status,
        0,
        `${relativePath} must remain generated-only in the source checkout.\n${trackedResult.stderr || trackedResult.stdout}`
    );

    const ignoredResult = childProcess.spawnSync('git', ['check-ignore', relativePath], {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(
        ignoredResult.status,
        0,
        `${relativePath} must remain ignored by root .gitignore.\n${ignoredResult.stdout || ignoredResult.stderr}`
    );
}

function copyDirRecursive(src: string, dst: string): void {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, dstPath);
        } else {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}

function setupMaterializedWorkspace(): MaterializedWorkspace {
    const repoRoot = getRepoRoot();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-repo-governance-'));
    const bundleRoot = path.join(projectRoot, 'garda-agent-orchestrator');
    const initAnswersPath = path.join(bundleRoot, 'runtime', 'init-answers.json');

    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundleRoot, 'VERSION'));
    copyDirRecursive(path.join(repoRoot, 'template'), path.join(bundleRoot, 'template'));
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.git', 'hooks'), { recursive: true });

    fs.writeFileSync(initAnswersPath, JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'GitHubCopilot',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE',
        ActiveAgentFiles: '.github/copilot-instructions.md, CLAUDE.md'
    }, null, 2), 'utf8');

    runInstall({
        targetRoot: projectRoot,
        bundleRoot,
        assistantLanguage: 'English',
        assistantBrevity: 'concise',
        sourceOfTruth: 'GitHubCopilot',
        initAnswersPath,
        runInit: true,
        initRunner: (options) => {
            runInit({
                targetRoot: options.targetRoot,
                bundleRoot,
                assistantLanguage: options.assistantLanguage,
                assistantBrevity: options.assistantBrevity,
                sourceOfTruth: options.sourceOfTruth,
                enforceNoAutoCommit: options.enforceNoAutoCommit,
                tokenEconomyEnabled: options.tokenEconomyEnabled
            });
        }
    });

    return { projectRoot, bundleRoot };
}

before(() => {
    materializedWorkspace = setupMaterializedWorkspace();
});

after(() => {
    if (!materializedWorkspace) {
        return;
    }
    fs.rmSync(materializedWorkspace.projectRoot, { recursive: true, force: true });
    materializedWorkspace = null;
});

test('repo governance files use the current owner handle and root-relative paths', () => {
    const codeowners = readRepoFile('.github/CODEOWNERS');
    const branchProtection = readRepoFile('docs/branch-protection.md');
    const gitleaks = readRepoFile('.gitleaks.toml');

    assert.ok(!codeowners.includes('@anthropic-team/orchestrator-maintainers'));
    assert.match(codeowners, /@Shubchynskyi/);
    for (const pattern of [
        'runtime/',
        'garda-agent-orchestrator/runtime/',
        'live/docs/agent-rules/',
        'garda-agent-orchestrator/live/docs/agent-rules/',
        'live/config/',
        'garda-agent-orchestrator/live/config/',
        'live/skills/',
        'garda-agent-orchestrator/live/skills/',
        'src/',
        'garda-agent-orchestrator/src/',
        'bin/',
        'garda-agent-orchestrator/bin/',
        'dist/',
        'garda-agent-orchestrator/dist/',
        'template/',
        'garda-agent-orchestrator/template/'
    ]) {
        assert.match(
            codeowners,
            new RegExp(`^${escapeRegExp(pattern)}\\s+@Shubchynskyi$`, 'm'),
            `CODEOWNERS must cover ${pattern}`
        );
    }

    assert.ok(!branchProtection.includes('@anthropic-team/orchestrator-maintainers'));
    assert.match(branchProtection, /@Shubchynskyi/);
    assert.match(branchProtection, /runtime\/.*garda-agent-orchestrator\/runtime\//s);
    assert.match(branchProtection, /src\/.*garda-agent-orchestrator\/src\//s);

    assert.ok(!gitleaks.includes("'''tests/.*'''"));
    assert.ok(!gitleaks.includes("'''dist/.*'''"));
    assert.match(gitleaks, /'''runtime\/\.\*'''/);
    assert.match(gitleaks, /'''garda-agent-orchestrator\/runtime\/\.\*'''/);
    assert.ok(gitleaks.includes("'''tests/node/core/redaction\\.test\\.ts'''"));
});

test('review artifact templates point new cycles to generated findings-only JSON', () => {
    const template = readRepoFile('template/docs/reviews/TEMPLATE.md');
    const materializedLiveTemplate = readGeneratedRepoFile('garda-agent-orchestrator/live/docs/reviews/TEMPLATE.md');

    for (const [label, content] of [
        ['template docs review artifact template', template],
        ['materialized live review artifact template', materializedLiveTemplate]
    ] as const) {
        assert.match(content, /Findings-Only Review Result Contract/u, `${label} must identify the active contract`);
        assert.match(content, /generated output template is the immutable fill-in form/u);
        assert.match(content, /review-findings-report\.schema\.json/u);
        assert.match(content, /must not contain verdict, pass\/fail, status, downstream/u);
        assert.match(content, /Historical heading-based review artifacts remain readable for audit/u);
        assert.doesNotMatch(content, /^## Verdict$/mu, `${label} must not expose a new-cycle verdict field`);
    }
});

test('template TASK scaffold is tracked and not ignored by root gitignore', () => {
    const repoRoot = getRepoRoot();
    const templateTaskPath = path.join(repoRoot, 'template', 'TASK.md');

    assert.ok(fs.existsSync(templateTaskPath), 'template/TASK.md must exist on disk');
    assertRepoFileTrackedAndNotIgnored('template/TASK.md');
});

test('source-checkout generated router files stay synced with builder output when materialized locally', () => {
    const repoRoot = getRepoRoot();
    const normalize = (content: string) => content.replace(/\r\n/g, '\n').trim();
    const generatedFiles = [
        ['.agents/workflows/start-task.md', buildSharedStartTaskWorkflowContent('AGENTS.md')],
        ['.github/agents/orchestrator.md', buildProviderOrchestratorAgentContent('GitHub Copilot', 'AGENTS.md', '.github/agents/orchestrator.md')],
        ['.windsurf/agents/orchestrator.md', buildProviderOrchestratorAgentContent('Windsurf', 'AGENTS.md', '.windsurf/agents/orchestrator.md')],
        ['.junie/agents/orchestrator.md', buildProviderOrchestratorAgentContent('Junie', 'AGENTS.md', '.junie/agents/orchestrator.md')],
        ['.antigravity/agents/orchestrator.md', buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md')]
    ] as const;
    for (const [relativePath, expectedContent] of generatedFiles) {
        assertRepoFileIgnoredAndNotTracked(relativePath);
        const filePath = path.join(repoRoot, relativePath);
        if (!fs.existsSync(filePath)) {
            continue;
        }
        assert.equal(
            normalize(fs.readFileSync(filePath, 'utf8')),
            normalize(expectedContent),
            `${relativePath} must stay synced with generated content when materialized locally`
        );
    }
});

test('start-banner contract stays synced across canonical guidance files', () => {
    const uxMarkerText = 'this UX marker is not gate evidence';
    const evidenceDecouplingText = 'Do not use start-marker presence or exact text as hard evidence';
    const legacyStartMarker = 'files not modified yet';
    const normalize = (content: string) => content.replace(/\r\n/g, '\n').trim();
    const expectedTemplateSharedRouterContent = normalize(buildSharedStartTaskWorkflowContent('AGENTS.md'));
    const expectedMaterializedSharedRouterContent = normalize(buildSharedStartTaskWorkflowContent('.github/copilot-instructions.md'));

    const trackedCanonicalFiles = [
        'template/skills/orchestration/SKILL.md',
        'template/docs/agent-rules/40-commands.md',
        'template/docs/agent-rules/90-skill-catalog.md'
    ] as const;

    const materializedGeneratedFiles = [
        '.agents/workflows/start-task.md',
        'garda-agent-orchestrator/live/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/live/docs/agent-rules/40-commands.md',
        'garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md',
        'garda-agent-orchestrator/live/skills/orchestration-depth1/SKILL.md',
        'garda-agent-orchestrator/template/.agents/workflows/start-task.md',
        'garda-agent-orchestrator/template/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/template/skills/orchestration-depth1/SKILL.md',
        'garda-agent-orchestrator/template/docs/agent-rules/40-commands.md',
        'garda-agent-orchestrator/template/docs/agent-rules/90-skill-catalog.md',
        'garda-agent-orchestrator/template/docs/agent-rules/80-task-workflow.md',
        'garda-agent-orchestrator/template/entrypoints/canonical-rule-index.md'
    ] as const;

    for (const relativePath of trackedCanonicalFiles) {
        const content = readRepoFile(relativePath);
        assert.equal(content.includes('--start-banner "<repo-owned-banner>"'), false, `${relativePath} must not require the repo-owned start banner flag`);
    }

    for (const relativePath of [
        'template/skills/orchestration/SKILL.md',
        'template/skills/orchestration-depth1/SKILL.md',
        'template/.agents/workflows/start-task.md'
    ]) {
        const content = readRepoFile(relativePath);
        assert.ok(content.includes(uxMarkerText), `${relativePath} must preserve start-marker UX guidance`);
        assert.ok(content.includes(evidenceDecouplingText), `${relativePath} must preserve start-marker evidence decoupling`);
    }

    for (const relativePath of [
        'template/skills/orchestration/SKILL.md',
        'template/skills/orchestration-depth1/SKILL.md',
        'template/.agents/workflows/start-task.md'
    ]) {
        const content = readRepoFile(relativePath);
        assert.ok(!content.includes(legacyStartMarker), `${relativePath} must not keep the legacy start marker`);
    }

    assert.equal(
        normalize(readRepoFile('template/.agents/workflows/start-task.md')),
        expectedTemplateSharedRouterContent,
        'template/.agents/workflows/start-task.md must stay in exact parity with canonical builder output'
    );

    for (const relativePath of materializedGeneratedFiles) {
        const content = readGeneratedRepoFile(relativePath);
        if (
            relativePath.endsWith('/skills/orchestration/SKILL.md')
            || relativePath.endsWith('/docs/agent-rules/40-commands.md')
            || relativePath.endsWith('/docs/agent-rules/90-skill-catalog.md')
        ) {
            assert.equal(content.includes('--start-banner "<repo-owned-banner>"'), false, `${relativePath} must not require the repo-owned start banner flag`);
        }
        if (
            relativePath.endsWith('/skills/orchestration/SKILL.md')
            || relativePath.endsWith('/skills/orchestration-depth1/SKILL.md')
            || relativePath === '.agents/workflows/start-task.md'
            || relativePath.endsWith('/.agents/workflows/start-task.md')
        ) {
            assert.ok(content.includes(uxMarkerText), `${relativePath} must preserve start-marker UX guidance`);
            assert.ok(content.includes(evidenceDecouplingText), `${relativePath} must preserve start-marker evidence decoupling`);
        }
        if (
            relativePath === '.agents/workflows/start-task.md'
            || relativePath.endsWith('/template/.agents/workflows/start-task.md')
        ) {
            assert.equal(
                normalize(content),
                relativePath === '.agents/workflows/start-task.md'
                    ? expectedMaterializedSharedRouterContent
                    : expectedTemplateSharedRouterContent,
                `${relativePath} must stay in exact parity with canonical builder output`
            );
        }
        if (
            relativePath.endsWith('/template/entrypoints/canonical-rule-index.md')
            || relativePath.endsWith('/docs/agent-rules/80-task-workflow.md')
            || relativePath.endsWith('/skills/orchestration/SKILL.md')
            || relativePath.endsWith('/skills/orchestration-depth1/SKILL.md')
            || relativePath === '.agents/workflows/start-task.md'
            || relativePath.endsWith('/.agents/workflows/start-task.md')
        ) {
            assert.ok(!content.includes(legacyStartMarker), `${relativePath} must not keep the legacy start marker`);
        }
    }
});

test('integrity-priority wording stays synced across tracked and materialized rule files', () => {
    const workflowSection = [
        '## Integrity Priority Rules',
        '- Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
        '- Mandatory gate failure means stop or `BLOCKED`; never workaround the gate, script around it, or claim progress that depends on missing evidence.',
        '- Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
        '- Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.',
        '- If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.'
    ].join('\n');
    const skillCatalogSection = [
        '## Integrity Priority Rules',
        '- Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
        '- Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.',
        '- Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
        '- If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.'
    ].join('\n');

    for (const relativePath of [
        'template/docs/agent-rules/80-task-workflow.md',
        'template/docs/agent-rules/90-skill-catalog.md'
    ] as const) {
        const content = readRepoFile(relativePath);
        const sectionContent = extractMarkdownSection(content, '## Integrity Priority Rules');
        const expectedSection = relativePath.endsWith('80-task-workflow.md') ? workflowSection : skillCatalogSection;
        assert.equal(sectionContent.trim(), expectedSection, `${relativePath} must preserve exact integrity-priority section parity`);
    }

    for (const relativePath of [
        'garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md',
        'garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md',
        'garda-agent-orchestrator/template/docs/agent-rules/80-task-workflow.md',
        'garda-agent-orchestrator/template/docs/agent-rules/90-skill-catalog.md'
    ] as const) {
        const content = readGeneratedRepoFile(relativePath);
        const sectionContent = extractMarkdownSection(content, '## Integrity Priority Rules');
        const expectedSection = relativePath.endsWith('80-task-workflow.md') ? workflowSection : skillCatalogSection;
        assert.equal(sectionContent.trim(), expectedSection, `${relativePath} must preserve exact integrity-priority section parity`);
    }
});

test('task-status ownership wording stays synced across orchestration guidance files', () => {
    const trackedFiles = [
        'template/skills/orchestration/SKILL.md',
        'template/skills/orchestration-depth1/SKILL.md',
        'template/skills/orchestration/references/stage-gates.md',
        'template/docs/agent-rules/80-task-workflow.md'
    ] as const;

    const materializedFiles = [
        'garda-agent-orchestrator/live/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/template/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/live/skills/orchestration-depth1/SKILL.md',
        'garda-agent-orchestrator/template/skills/orchestration-depth1/SKILL.md',
        'garda-agent-orchestrator/live/skills/orchestration/references/stage-gates.md',
        'garda-agent-orchestrator/template/skills/orchestration/references/stage-gates.md',
        'garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md',
        'garda-agent-orchestrator/template/docs/agent-rules/80-task-workflow.md'
    ] as const;

    for (const relativePath of trackedFiles) {
        const content = readRepoFile(relativePath);
        assert.ok(!content.includes('Move task to `IN_REVIEW`.'), `${relativePath} must not instruct manual IN_REVIEW transitions`);
        assert.ok(!content.includes('moved to `IN_PROGRESS`.'), `${relativePath} must not describe IN_PROGRESS as a manual move`);
        assert.ok(!content.includes('Task marked `DONE`.'), `${relativePath} must not describe DONE as a hand-authored step`);
        assert.ok(!content.includes('Set task status to `BLOCKED` when gate cannot be satisfied now.'), `${relativePath} must not instruct manual BLOCKED wording`);
    }

    for (const relativePath of materializedFiles) {
        const content = readGeneratedRepoFile(relativePath);
        assert.ok(!content.includes('Move task to `IN_REVIEW`.'), `${relativePath} must not instruct manual IN_REVIEW transitions`);
        assert.ok(!content.includes('moved to `IN_PROGRESS`.'), `${relativePath} must not describe IN_PROGRESS as a manual move`);
        assert.ok(!content.includes('Task marked `DONE`.'), `${relativePath} must not describe DONE as a hand-authored step`);
        assert.ok(!content.includes('Set task status to `BLOCKED` when gate cannot be satisfied now.'), `${relativePath} must not instruct manual BLOCKED wording`);
    }

    const trackedExpectedSnippets = new Map<string, string>([
        ['template/skills/orchestration/SKILL.md', 'reconciles it to `IN_PROGRESS`'],
        ['template/skills/orchestration-depth1/SKILL.md', 'gate flow owns `IN_PROGRESS`, `IN_REVIEW`, `SPLIT_REQUIRED`, and `DONE`'],
        ['template/skills/orchestration/references/stage-gates.md', 'Completion finalization reconciles the task to `DONE`.'],
        ['template/docs/agent-rules/80-task-workflow.md', 'Gate flow owns forward `TASK.md` status transitions to `IN_PROGRESS`, `IN_REVIEW`, `SPLIT_REQUIRED`, and `DONE`']
    ]);

    for (const [relativePath, expectedSnippet] of trackedExpectedSnippets) {
        const content = readRepoFile(relativePath);
        assert.ok(content.includes(expectedSnippet), `${relativePath} must preserve gate-owned status wording`);
    }
});

test('reviewer session contract stays synced across rule-pack guidance files', () => {
    const requiredSnippets = [
        'Reusing a prior review artifact or receipt is valid only through explicit current-cycle reuse evidence',
        'Reusing the same reviewer session for a new mandatory review is not valid fresh-context launch evidence',
        'After the review receipt is persisted by `record-review-result` or `record-review-receipt`, close or release the reviewer sub-agent session.'
    ] as const;
    const trackedFiles = [
        'template/docs/agent-rules/80-task-workflow.md',
        'template/docs/agent-rules/90-skill-catalog.md'
    ] as const;
    const materializedFiles = [
        'garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md',
        'garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md',
        'garda-agent-orchestrator/template/docs/agent-rules/80-task-workflow.md',
        'garda-agent-orchestrator/template/docs/agent-rules/90-skill-catalog.md'
    ] as const;
    const skillSnippets = [
        'do not reuse an existing reviewer session',
        'close or release the reviewer',
        'receipt persistence'
    ] as const;
    const trackedSkillFiles = [
        'template/skills/orchestration/SKILL.md',
        'template/skills/orchestration-depth1/SKILL.md'
    ] as const;
    const materializedSkillFiles = [
        'garda-agent-orchestrator/live/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/template/skills/orchestration/SKILL.md',
        'garda-agent-orchestrator/live/skills/orchestration-depth1/SKILL.md',
        'garda-agent-orchestrator/template/skills/orchestration-depth1/SKILL.md'
    ] as const;

    for (const relativePath of trackedFiles) {
        const content = readRepoFile(relativePath);
        for (const snippet of requiredSnippets) {
            assert.ok(content.includes(snippet), `${relativePath} must include reviewer session contract snippet: ${snippet}`);
        }
    }

    for (const relativePath of materializedFiles) {
        const content = readGeneratedRepoFile(relativePath);
        for (const snippet of requiredSnippets) {
            assert.ok(content.includes(snippet), `${relativePath} must include reviewer session contract snippet: ${snippet}`);
        }
    }

    for (const relativePath of trackedSkillFiles) {
        const content = readRepoFile(relativePath);
        for (const snippet of skillSnippets) {
            assert.ok(content.includes(snippet), `${relativePath} must include reviewer session skill snippet: ${snippet}`);
        }
    }

    for (const relativePath of materializedSkillFiles) {
        const content = readGeneratedRepoFile(relativePath);
        for (const snippet of skillSnippets) {
            assert.ok(content.includes(snippet), `${relativePath} must include reviewer session skill snippet: ${snippet}`);
        }
    }
});

const GENERATED_HANDOFF_AUTHORITY_SNIPPETS = [
    '## Generated Findings-Only Handoff',
    'sole instruction and output-format authority',
    'Never modify source files, control artifacts, or task state',
    'never launch another agent',
    'only permitted write is the exact `ReviewOutputPath`',
    'exactly one findings-only JSON object',
    'every coverage-ledger obligation',
    'do not add verdict, pass/fail, status, downstream disposition, or remediation fields'
] as const;

function assertGeneratedHandoffAuthority(content: string, label: string): void {
    for (const snippet of GENERATED_HANDOFF_AUTHORITY_SNIPPETS) {
        const sentenceCaseSnippet = snippet.replace(/^do\b/u, 'Do');
        assert.ok(content.includes(snippet) || content.includes(sentenceCaseSnippet),
            `${label} must include findings-only handoff snippet: ${snippet}`);
    }
    assert.ok(
        content.indexOf('## Generated Findings-Only Handoff') < content.indexOf('## Core Workflow')
            || !content.includes('## Core Workflow'),
        `${label} must establish the generated contract before workflow guidance`
    );
}

test('reviewer skill templates make generated findings-only handoff authoritative', () => {
    const reviewerSkillPaths = [
        'template/skills/code-review/SKILL.md',
        'template/skills/db-review/SKILL.md',
        'template/skills/security-review/SKILL.md',
        'template/skills/refactor-review/SKILL.md',
        'template/skills/dependency-review/SKILL.md',
        'template/skill-packs/quality-architecture/skills/api-contract-review/SKILL.md',
        'template/skill-packs/quality-architecture/skills/testing-strategy/SKILL.md',
        'template/skill-packs/quality-architecture/skills/performance-review/SKILL.md',
        'template/skill-packs/quality-architecture/skills/architecture-review/SKILL.md',
        'template/skill-packs/devops-k8s/skills/devops-k8s/SKILL.md',
        'template/skill-packs/ai-agentic/skills/multi-agent-review/SKILL.md',
        'template/skill-packs/data-database/skills/sql-review/SKILL.md',
        'template/skill-packs/data-database/skills/prisma-review/SKILL.md',
        'template/skill-packs/data-database/skills/db-migration-review/SKILL.md',
        'template/skill-packs/frontend-web/skills/frontend-accessibility/SKILL.md'
    ] as const;

    for (const relativePath of reviewerSkillPaths) {
        assertRepoFileTrackedAndNotIgnored(relativePath);
        assertGeneratedHandoffAuthority(readRepoFile(relativePath), relativePath);
    }
});

test('generated handoff governance accepts sentence case without obsolete recipes and rejects missing authority', () => {
    const content = readRepoFile('template/skills/code-review/SKILL.md');
    assert.doesNotMatch(content, /historical audit-only guidance and never applies to generated or other new review cycles/iu);
    assertGeneratedHandoffAuthority(content, 'current code-review');
    const lowerCaseDirective = content.replace('Do not add verdict,', 'do not add verdict,');
    assert.notEqual(lowerCaseDirective, content);
    assertGeneratedHandoffAuthority(lowerCaseDirective, 'lower-case directive');
    const wrongOutputPathCase = content.replace('`ReviewOutputPath`', '`reviewoutputpath`');
    assert.notEqual(wrongOutputPathCase, content);
    assert.throws(() => assertGeneratedHandoffAuthority(wrongOutputPathCase, 'wrong output-path field case'),
        /must include findings-only handoff snippet/u);
    for (const snippet of GENERATED_HANDOFF_AUTHORITY_SNIPPETS) {
        const position = content.toLowerCase().indexOf(snippet.toLowerCase());
        assert.notEqual(position, -1);
        const missingAuthority = content.slice(0, position) + content.slice(position + snippet.length);
        assert.throws(() => assertGeneratedHandoffAuthority(missingAuthority, 'missing obligation'),
            /must include findings-only handoff snippet/u);
    }
});
