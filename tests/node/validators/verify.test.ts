import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../src/core/constants';
import { listSkillPacks, validateSkillPacks } from '../../../src/runtime/skills';
import {
    parseBooleanLike,
    readVerifyInitAnswers,
    runVerify,
    formatVerifyResult,
    formatVerifyResultCompact,
    detectCommandsViolations,
    detectTaskModeRuleContractViolations,
    detectCoreRuleViolations,
    detectEntrypointViolations,
    detectTaskViolations,
    detectQwenSettingsViolations
} from '../../../src/validators';

function cleanupVerifyTempDir(tmpDir: string): void {
    fs.rmSync(tmpDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100
    });
}

function writeInitAnswersFixture(targetRoot: string) {
    const answersDir = path.join(targetRoot, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Claude',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true'
        }),
        'utf8'
    );
}

function requiredCommandContractSnippets(): string[] {
    return [
        'node garda-agent-orchestrator/bin/garda.js gate enter-task-mode',
        'node garda-agent-orchestrator/bin/garda.js gate load-rule-pack',
        'node garda-agent-orchestrator/bin/garda.js gate classify-change',
        'node garda-agent-orchestrator/bin/garda.js gate compile-gate',
        'node garda-agent-orchestrator/bin/garda.js gate required-reviews-check',
        'node garda-agent-orchestrator/bin/garda.js gate doc-impact-gate',
        'node garda-agent-orchestrator/bin/garda.js gate completion-gate',
        'node garda-agent-orchestrator/bin/garda.js gate log-task-event',
        'node garda-agent-orchestrator/bin/garda.js gate task-events-summary',
        'node garda-agent-orchestrator/bin/garda.js gate build-scoped-diff',
        'node garda-agent-orchestrator/bin/garda.js gate build-review-context',
        'node garda-agent-orchestrator/bin/garda.js gate validate-manifest'
    ];
}

test('parseBooleanLike handles true values', () => {
    assert.equal(parseBooleanLike(true, false), true);
    assert.equal(parseBooleanLike('true', false), true);
    assert.equal(parseBooleanLike('yes', false), true);
    assert.equal(parseBooleanLike('1', false), true);
    assert.equal(parseBooleanLike('on', false), true);
    assert.equal(parseBooleanLike('да', false), true);
});

test('parseBooleanLike handles false values', () => {
    assert.equal(parseBooleanLike(false, true), false);
    assert.equal(parseBooleanLike('false', true), false);
    assert.equal(parseBooleanLike('no', true), false);
    assert.equal(parseBooleanLike('0', true), false);
    assert.equal(parseBooleanLike('off', true), false);
    assert.equal(parseBooleanLike('нет', true), false);
});

test('parseBooleanLike returns default for null/undefined', () => {
    assert.equal(parseBooleanLike(null, true), true);
    assert.equal(parseBooleanLike(undefined, false), false);
});

test('readVerifyInitAnswers reports missing file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        const result = readVerifyInitAnswers(
            tmpDir,
            'garda-agent-orchestrator/runtime/init-answers.json',
            'Claude'
        );
        assert.ok(result.violations.some(v => v.includes('missing')));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('readVerifyInitAnswers validates fields', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const answersDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Claude',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE'
        }),
        'utf8'
    );

    try {
        const result = readVerifyInitAnswers(
            tmpDir,
            'garda-agent-orchestrator/runtime/init-answers.json',
            'Claude'
        );
        assert.equal(result.violations.length, 0);
        assert.equal(result.assistantLanguage, 'English');
        assert.equal(result.assistantBrevity, 'concise');
        assert.equal(result.enforceNoAutoCommit, false);
        assert.equal(result.claudeOrchestratorFullAccess, false);
        assert.equal(result.tokenEconomyEnabled, true);
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('readVerifyInitAnswers catches source-of-truth mismatch', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const answersDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true'
        }),
        'utf8'
    );

    try {
        const result = readVerifyInitAnswers(
            tmpDir,
            'garda-agent-orchestrator/runtime/init-answers.json',
            'Claude'
        );
        assert.ok(result.violations.some(v => v.includes('does not match')));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('readVerifyInitAnswers catches invalid brevity', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const answersDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(answersDir, { recursive: true });
    fs.writeFileSync(
        path.join(answersDir, 'init-answers.json'),
        JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'verbose',
            SourceOfTruth: 'Claude',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true'
        }),
        'utf8'
    );

    try {
        const result = readVerifyInitAnswers(
            tmpDir,
            'garda-agent-orchestrator/runtime/init-answers.json',
            'Claude'
        );
        assert.ok(result.violations.some(v => v.includes('AssistantBrevity')));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectCommandsViolations returns empty for missing file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        const violations = detectCommandsViolations(tmpDir);
        assert.deepEqual(violations, []);
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectCommandsViolations rejects test command in compile gate section', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const rulesDir = path.join(
        tmpDir,
        'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'
    );
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, '40-commands.md'), [
        '# Commands',
        '',
        '### Compile Gate (Mandatory)',
        '```bash',
        'npm test',
        '```',
        '',
        ...requiredCommandContractSnippets()
    ].join('\n'), 'utf8');

    try {
        const violations = detectCommandsViolations(tmpDir);
        assert.ok(violations.some((violation) => /must not run the full test suite/i.test(violation)));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectCommandsViolations allows unconfigured compile-gate sentinel in human-visible commands file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const rulesDir = path.join(
        tmpDir,
        'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'
    );
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, '40-commands.md'), [
        '# Commands',
        '',
        '### Compile Gate (Mandatory)',
        '```bash',
        '__COMPILE_GATE_COMMAND_UNCONFIGURED__',
        '```',
        '',
        'See `40-command-reference.md` for optional tool-specific command tables.',
        '',
        ...requiredCommandContractSnippets()
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(rulesDir, '40-command-reference.md'), [
        '# Command Reference Appendix',
        '',
        '## Version Control (git)',
        '',
        '## Package Managers',
        '',
        '## Build, Lint, And Type-Check',
        '`--noEmit --pretty false`',
        '`--format=compact`',
        '',
        '## Search And File Inspection',
        '`rg -l --max-count=5 pattern src/`',
        '',
        '## Containers And Infrastructure',
        '`docker logs --tail 50 c`'
    ].join('\n'), 'utf8');

    try {
        const violations = detectCommandsViolations(tmpDir);
        assert.deepEqual(violations, []);
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectCommandsViolations requires command reference appendix when core commands defers tables', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const rulesDir = path.join(
        tmpDir,
        'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'
    );
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, '40-commands.md'), [
        '# Commands',
        '',
        '### Compile Gate (Mandatory)',
        '```bash',
        '__COMPILE_GATE_COMMAND_UNCONFIGURED__',
        '```',
        '',
        'See `40-command-reference.md` for optional tool-specific command tables.',
        '',
        ...requiredCommandContractSnippets()
    ].join('\n'), 'utf8');

    try {
        const violations = detectCommandsViolations(tmpDir);
        assert.ok(violations.some((violation) => violation.includes('40-command-reference.md must exist')));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('runVerify reports project commands pending when workflow compile gate command is unconfigured', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        writeInitAnswersFixture(tmpDir);
        const configDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
            compile_gate: {
                command: UNCONFIGURED_COMPILE_GATE_COMMAND
            }
        }, null, 2), 'utf8');

        const result = runVerify({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json'
        });

        assert.equal(result.passed, false);
        assert.ok(
            result.violations.commandsContractViolations.some(
                (violation) => violation.includes('compile_gate.command is unconfigured') &&
                    violation.includes('PROJECT_COMMANDS_PENDING')
            )
        );
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectTaskModeRuleContractViolations reports stale task-mode rule snippets', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const rulesDir = path.join(
        tmpDir,
        'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'
    );
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, '40-commands.md'), '# Commands\n\n## Agent Gates\n```bash\nnode garda-agent-orchestrator/bin/garda.js gate classify-change\n```\n', 'utf8');
    fs.writeFileSync(path.join(rulesDir, '80-task-workflow.md'), '# Task Workflow\n\n## Mandatory Gate Contract\n- Preflight artifact must exist before review stage.\n', 'utf8');
    fs.writeFileSync(path.join(rulesDir, '90-skill-catalog.md'), '# Skill Catalog\n\n## Preflight Gate (Mandatory)\n- Run before review stage.\n\n## Enforcement\n- Missing preflight artifact blocks progression.\n', 'utf8');

    try {
        const violations = detectTaskModeRuleContractViolations(tmpDir);
        assert.ok(violations.some(v => v.includes("40-commands.md must include task-mode contract snippet 'node garda-agent-orchestrator/bin/garda.js gate load-rule-pack'")));
        assert.ok(violations.some(v => v.includes("40-commands.md must include task-mode contract snippet 'node garda-agent-orchestrator/bin/garda.js gate enter-task-mode'")));
        assert.ok(violations.some(v => v.includes("80-task-workflow.md must include task-mode contract snippet 'Baseline downstream rules must be opened and recorded before preflight:'")));
        assert.ok(violations.some(v => v.includes("80-task-workflow.md must include task-mode contract snippet 'Task-mode entry command must pass before preflight or implementation:'")));
        assert.ok(violations.some(v => v.includes("80-task-workflow.md must include task-mode contract snippet '## Integrity Priority Rules'")));
        assert.ok(violations.some(v => v.includes("80-task-workflow.md must include task-mode contract snippet 'Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.'")));
        assert.ok(violations.some(v => v.includes("90-skill-catalog.md must include task-mode contract snippet 'Missing rule-pack artifact (`runtime/reviews/<task-id>-rule-pack.json`) blocks progression.'")));
        assert.ok(violations.some(v => v.includes("90-skill-catalog.md must include task-mode contract snippet 'Missing task-mode entry artifact (`runtime/reviews/<task-id>-task-mode.json`) blocks progression.'")));
        assert.ok(violations.some(v => v.includes("90-skill-catalog.md must include task-mode contract snippet '## Integrity Priority Rules'")));
        assert.ok(violations.some(v => v.includes("90-skill-catalog.md must include task-mode contract snippet 'Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.'")));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectTaskModeRuleContractViolations rejects duplicated snippets outside the target section', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const rulesDir = path.join(
        tmpDir,
        'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'
    );
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, '80-task-workflow.md'), [
        '# Task Workflow',
        '',
        '## Integrity Priority Rules',
        'Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
        '',
        '## Appendix',
        'Mandatory gate failure means stop or `BLOCKED`; never workaround the gate, script around it, or claim progress that depends on missing evidence.',
        'Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
        'Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.',
        'If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(rulesDir, '90-skill-catalog.md'), [
        '# Skill Catalog',
        '',
        '## Integrity Priority Rules',
        'Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
        '',
        '## Appendix',
        'Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.',
        'Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
        'If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.'
    ].join('\n'), 'utf8');

    try {
        const violations = detectTaskModeRuleContractViolations(tmpDir);
        assert.ok(violations.some(v => v.includes("80-task-workflow.md must include task-mode contract snippet 'Mandatory gate failure means stop or `BLOCKED`; never workaround the gate, script around it, or claim progress that depends on missing evidence.'")));
        assert.ok(violations.some(v => v.includes("90-skill-catalog.md must include task-mode contract snippet 'Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.'")));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectTaskModeRuleContractViolations rejects exact section drift when template exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const rulesDir = path.join(
        tmpDir,
        'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'
    );
    const templateRulesDir = path.join(
        tmpDir,
        'garda-agent-orchestrator', 'template', 'docs', 'agent-rules'
    );
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.mkdirSync(templateRulesDir, { recursive: true });
    const workflowTemplate = [
        '# Task Workflow',
        '',
        '## Agent Start Contract',
        'At fresh main-agent task start, show one English start marker from the repo-owned list once in the first relevant reply; this UX marker is not gate evidence.',
        '',
        '## Integrity Priority Rules',
        'Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
        'Mandatory gate failure means stop or `BLOCKED`; never workaround the gate, script around it, or claim progress that depends on missing evidence.',
        'Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
        'Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.',
        'If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.',
        '',
        '## Mandatory Gate Contract',
        'TASK_MODE_ENTERED'
    ].join('\n');
    const skillCatalogTemplate = [
        '# Skill Catalog',
        '',
        '## Integrity Priority Rules',
        'Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
        'Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.',
        'Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
        'If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.',
        '',
        '## Preflight Gate (Mandatory)',
        'node garda-agent-orchestrator/bin/garda.js gate enter-task-mode',
        '',
        '## Enforcement',
        'Missing task-mode entry artifact (`runtime/reviews/<task-id>-task-mode.json`) blocks progression.'
    ].join('\n');
    fs.writeFileSync(path.join(templateRulesDir, '80-task-workflow.md'), workflowTemplate, 'utf8');
    fs.writeFileSync(path.join(templateRulesDir, '90-skill-catalog.md'), skillCatalogTemplate, 'utf8');
    fs.writeFileSync(path.join(rulesDir, '80-task-workflow.md'), workflowTemplate.replace(
        'Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.',
        'Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.\nExceptions may be tolerated during fast-moving review cycles.'
    ), 'utf8');
    fs.writeFileSync(path.join(rulesDir, '90-skill-catalog.md'), skillCatalogTemplate.replace(
        'Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.',
        'Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.\nOptional skills may still bypass some validation when context is tight.'
    ), 'utf8');

    try {
        const violations = detectTaskModeRuleContractViolations(tmpDir);
        assert.ok(violations.some(v => v.includes("80-task-workflow.md section '## Integrity Priority Rules' must stay synchronized with template source.")));
        assert.ok(violations.some(v => v.includes("90-skill-catalog.md section '## Integrity Priority Rules' must stay synchronized with template source.")));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectTaskModeRuleContractViolations accepts current task-mode contract snippets', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const rulesDir = path.join(
        tmpDir,
        'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'
    );
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, '40-commands.md'), [
        '# Commands',
        '',
        '### Compile Gate (Mandatory)',
        'Compile gate command must be a compile/build/type-check command.',
        'Do not use full-suite test commands here.',
        'node garda-agent-orchestrator/bin/garda.js gate compile-gate',
        '',
        '## Agent Gates',
        'node garda-agent-orchestrator/bin/garda.js gate enter-task-mode',
        'node garda-agent-orchestrator/bin/garda.js gate load-rule-pack',
        'node garda-agent-orchestrator/bin/garda.js gate bind-rule-pack-to-preflight',
        '`classify-change` fails without rule-pack evidence',
        'Compile gate additionally validates post-preflight rule-pack evidence',
        '`required-reviews-check` additionally validates post-preflight rule-pack evidence',
        'Compile gate additionally validates explicit task-mode entry evidence from `enter-task-mode`.',
        '`required-reviews-check` additionally validates explicit task-mode entry evidence (`TASK_MODE_ENTERED`) before review pass can succeed.',
        'pass the same `--task-mode-path` through `classify-change`, `load-rule-pack`, `bind-rule-pack-to-preflight`',
        '`build-review-context` before every required reviewer invocation, even when token economy is inactive',
        '`build-review-context` writes `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, and `SKILL_REFERENCE_LOADED` automatically for the selected review skill.',
        'ordered lifecycle evidence (`PREFLIGHT_CLASSIFIED`, `IMPLEMENTATION_STARTED`, `REVIEW_PHASE_STARTED`), real review-skill telemetry (`SKILL_SELECTED`, `SKILL_REFERENCE_LOADED`)',
        'Task timeline completeness is surfaced by `status` and `doctor`, not just completion-gate.',
        '',
        '### Optional Command Reference Appendix',
        'See `40-command-reference.md` for optional tool-specific command tables.',
        'Do not add the appendix to mandatory `TASK_ENTRY` or `POST_PREFLIGHT` rule-pack loads.'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(rulesDir, '80-task-workflow.md'), [
        '# Task Workflow',
        '',
        '## Agent Start Contract',
        'The canonical user instruction is: Execute task <task-id> from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.',
        'Active profile selection comes from `live/config/profiles.json` and the `TASK.md` `Profile` column; do not present `depth=<1|2|3>` as normal user task-start guidance.',
        'At fresh main-agent task start, show one English start marker from the repo-owned list once in the first relevant reply; this UX marker is not gate evidence.',
        'Do not use start-marker presence or exact text as hard evidence for task-mode, compile, review, completion, or task-audit gates.',
        'Reviewer agents, sub-agents, sidecars, and resumed cycles that already passed the start-banner step must not repeat it.',
        'If the workspace already contains modified files before task-mode entry and the run is not isolated through staged or explicit scope, stop and treat the start as invalid.',
        '',
        '## Review Catalog Context Contract',
        'Built-in review lanes and their canonical verdict tokens remain compatibility-owned.',
        'Custom review lanes are declarative and disabled by default.',
        'Task entry freezes an immutable current-task catalog/policy snapshot.',
        'Do not load `live/config/review-catalog.json` into normal task or reviewer context.',
        'Use `review-catalog list|show|explain|validate` for explicit inspection.',
        '',
        '## Integrity Priority Rules',
        'Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
        'Mandatory gate failure means stop or `BLOCKED`; never workaround the gate, script around it, or claim progress that depends on missing evidence.',
        'Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
        'Fabricated review artifacts, receipts, routing metadata, telemetry, task statuses, or commit-readiness claims are critical workflow violations.',
        'If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.',
        '',
        '## Mandatory Gate Contract',
        'Task-mode entry command must pass before preflight or implementation:',
        'TASK_MODE_ENTERED',
        'Baseline downstream rules must be opened and recorded before preflight:',
        'RULE_PACK_LOADED',
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'PREFLIGHT_STARTED',
        'IMPLEMENTATION_STARTED',
        'REVIEW_PHASE_STARTED',
        'SKILL_SELECTED',
        'SKILL_REFERENCE_LOADED',
        'Legacy update compatibility wording: After preflight decides `required_reviews.*`, re-run `load-rule-pack --stage "POST_PREFLIGHT" --preflight-path ...`. Current contract: After preflight decides `required_reviews.*`, run the exact POST_PREFLIGHT command printed by `next-step`',
        'Downstream review preparation must follow the current-cycle dependency graph from `preflight.review_execution_policy`; do not start `test` until every required upstream dependency for the active policy has an accepted findings receipt with findings-satisfied state.',
        'If a later cycle changes only test scope, still run `build-review-context` for reusable upstream `code` review first so current-cycle reuse evidence exists before `test` review starts.',
        'Compile gate validates post-preflight rule-pack evidence',
        'Review gate command validates task-mode entry evidence (`TASK_MODE_ENTERED`) for the same task id.',
        'Review gate command validates post-preflight rule-pack evidence (`RULE_PACK_LOADED`)',
        'node garda-agent-orchestrator/bin/garda.js gate task-audit-summary --task-id "<task-id>" --as-json',
        'Final user report order is mandatory: short agent-authored summary of what changed -> verbatim Garda final user report',
        'The Garda final user report artifact is generated by `task-audit-summary`; do not reinterpret, summarize, reorder, or rewrite it.',
        'paste `CopyPasteFinalUserReport` exactly as printed, without code fences, wrappers, paraphrase, interpretation, summarization, or reformatting',
        'final delivery must not add commit readiness or extra review-integrity prose outside the generated artifact.',
        'Commit command suggestions and commit permission questions are allowed only after the verbatim generated report and only when `next-step` lists them in `FinalReportOrder`.',
        'ordered lifecycle evidence (`TASK_MODE_ENTERED`, `RULE_PACK_LOADED`, `PREFLIGHT_CLASSIFIED`, `IMPLEMENTATION_STARTED`, `COMPILE_GATE_PASSED`, `REVIEW_PHASE_STARTED`, review pass evidence), review-skill telemetry (`SKILL_SELECTED`, `SKILL_REFERENCE_LOADED`)',
        'Task timeline completeness is surfaced in `status` and `doctor`',
        'HARD STOP: do not skip `load-rule-pack`',
        'HARD STOP: do not skip `enter-task-mode`',
        'HARD STOP: do not launch required reviewers without `build-review-context`; completion requires review-skill telemetry.'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(rulesDir, '90-skill-catalog.md'), [
        '# Skill Catalog',
        '',
        '## Integrity Priority Rules',
        'Honest execution and strict workflow compliance outrank speed, autonomy, context preservation, and token economy.',
        'Skill routing, optional skills, and token-economy settings never authorize skipping mandatory gates or synthesizing workflow evidence.',
        'Agent-authored scripts may automate ordinary repository work, but they must not batch, loop over, or green-light orchestrator gates or write review, receipt, routing, telemetry, status, or commit-readiness evidence unless the task itself is to change orchestrator code.',
        'If asked about workflow misconduct or integrity defects, disclose the full known set from the current run, not only the latest discovered issue.',
        '',
        '## Preflight Gate (Mandatory)',
        'Before preflight, enter task mode explicitly:',
        'node garda-agent-orchestrator/bin/garda.js gate enter-task-mode',
        'record the baseline downstream rules that were actually opened',
        'node garda-agent-orchestrator/bin/garda.js gate load-rule-pack',
        'Legacy update compatibility wording: After preflight, re-run `load-rule-pack --stage "POST_PREFLIGHT"`. Current contract: After preflight, run the exact POST_PREFLIGHT rule-pack command printed by `next-step`',
        'Use `bind-rule-pack-to-preflight` only when `next-step` prints it',
        'build-review-context --review-type "<review-type>" --depth "<1|2|3>"',
        'Review launch dependencies come from `preflight.review_execution_policy`; prepare `test` only after every required upstream dependency for the active policy has an accepted findings receipt with findings-satisfied state.',
        'On pure test-scope reruns, if the active policy keeps `test` downstream of `code`, run `build-review-context` for reusable upstream `code` review first so the current-cycle reuse receipt exists before launching `test` review.',
        '',
        '## Enforcement',
        'Missing task-mode entry artifact (`runtime/reviews/<task-id>-task-mode.json`) blocks progression.',
        'Missing rule-pack artifact (`runtime/reviews/<task-id>-rule-pack.json`) blocks progression.',
        'Missing baseline `RULE_PACK_LOADED` blocks preflight.',
        'Missing post-preflight rule-pack proof blocks compile/review/completion.',
        'Missing `REVIEW_PHASE_STARTED`, `SKILL_SELECTED`, or `SKILL_REFERENCE_LOADED` blocks completion for code-changing tasks.',
        'Incomplete task timeline evidence is surfaced by `status` and `doctor`.'
    ].join('\n'), 'utf8');

    try {
        const violations = detectTaskModeRuleContractViolations(tmpDir);
        assert.deepEqual(violations, []);
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectCoreRuleViolations catches missing file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        const violations = detectCoreRuleViolations(tmpDir, null, null);
        assert.ok(violations.some(v => v.includes('00-core.md missing')));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectCoreRuleViolations validates language and brevity lines', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const coreDir = path.join(
        tmpDir,
        'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'
    );
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(
        path.join(coreDir, '00-core.md'),
        'Respond in English for explanations and assistance.\nDefault response brevity: concise.\nshort agent-authored summary\nverbatim Garda final user report\n80-task-workflow.md\n',
        'utf8'
    );

    try {
        const violations = detectCoreRuleViolations(tmpDir, 'English', 'concise');
        assert.equal(violations.length, 0);
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectCoreRuleViolations catches language mismatch', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const coreDir = path.join(
        tmpDir,
        'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'
    );
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(
        path.join(coreDir, '00-core.md'),
        'Respond in English for explanations and assistance.\nDefault response brevity: concise.\n',
        'utf8'
    );

    try {
        const violations = detectCoreRuleViolations(tmpDir, 'Russian', 'concise');
        assert.ok(violations.some(v => v.includes('language does not match')));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectTaskViolations catches missing TASK.md', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        const violations = detectTaskViolations(tmpDir, 'CLAUDE.md');
        assert.ok(violations.some(v => v.includes('TASK.md missing')));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectTaskViolations accepts Profile column header', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        const taskContent = [
            '<!-- garda-agent-orchestrator:managed-start -->',
            '# TASK.md',
            'Canonical instructions entrypoint for orchestration: `CLAUDE.md`.',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-001 | 🟩 DONE | P1 | area | task | me | 2026-01-01 | default | done |',
            '<!-- garda-agent-orchestrator:managed-end -->'
        ].join('\n');
        fs.writeFileSync(path.join(tmpDir, 'TASK.md'), taskContent, 'utf8');
        const violations = detectTaskViolations(tmpDir, 'CLAUDE.md');
        assert.ok(!violations.some(v => v.includes('Profile')), 'Should accept Profile column');
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectTaskViolations rejects legacy Depth column header', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        const taskContent = [
            '<!-- garda-agent-orchestrator:managed-start -->',
            '# TASK.md',
            'Canonical instructions entrypoint for orchestration: `CLAUDE.md`.',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Depth | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-001 | 🟩 DONE | P1 | area | task | me | 2026-01-01 | 2 | done |',
            '<!-- garda-agent-orchestrator:managed-end -->'
        ].join('\n');
        fs.writeFileSync(path.join(tmpDir, 'TASK.md'), taskContent, 'utf8');
        const violations = detectTaskViolations(tmpDir, 'CLAUDE.md');
        assert.ok(violations.some(v => v.includes('Profile')), 'Should reject legacy Depth column');
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectEntrypointViolations catches missing entrypoint', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        const violations = detectEntrypointViolations(tmpDir, 'CLAUDE.md');
        assert.ok(violations.some(v => v.includes('Canonical entrypoint missing')));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectEntrypointViolations returns empty for null entrypoint', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        const violations = detectEntrypointViolations(tmpDir, null);
        assert.deepEqual(violations, []);
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('detectQwenSettingsViolations returns empty for missing file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        const violations = detectQwenSettingsViolations(tmpDir, 'CLAUDE.md');
        assert.deepEqual(violations, []);
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('runVerify returns failed result for empty workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        const result = runVerify({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json'
        });
        assert.equal(result.passed, false);
        assert.ok(result.totalViolationCount > 0);
        assert.equal(result.sourceOfTruth, 'Claude');
        assert.equal(result.canonicalEntrypoint, 'CLAUDE.md');
        assert.ok(result.violations.gitignoreMissing.includes('.qwen/'));
        assert.ok(!result.violations.gitignoreMissing.includes('.review-temp/'));
        assert.ok(result.violations.gitignoreMissing.includes('AGENTS.md'));
        assert.match(result.violations.skillPackContractViolations.join('\n'), /validation failed:.*root does not exist/i);
        assert.match(result.violations.skillsIndexContractViolations.join('\n'), /validation failed:.*root does not exist/i);
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

for (const invalidRoot of ['linked', 'dangling', 'file'] as const) {
    test(`runVerify returns failed diagnostics for a ${invalidRoot} bundle root while strict listing rejects it`, (t) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
        try {
            const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
            if (invalidRoot === 'file') {
                fs.writeFileSync(bundleRoot, 'not a directory');
            } else {
                const outside = path.join(tmpDir, 'outside');
                if (invalidRoot === 'linked') fs.mkdirSync(outside);
                try {
                    fs.symlinkSync(outside, bundleRoot, 'junction');
                } catch (error: unknown) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code || '')) {
                        t.skip(`Junctions unavailable: ${code}`);
                        return;
                    }
                    throw error;
                }
            }
            const diagnostic = invalidRoot === 'file' ? /not a directory/ : /symlink|junction/;
            assert.throws(() => validateSkillPacks(bundleRoot), diagnostic);
            assert.throws(() => listSkillPacks(bundleRoot, { refreshHeadlines: false }), diagnostic);

            const result = runVerify({
                targetRoot: tmpDir,
                sourceOfTruth: 'Claude',
                initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json'
            });
            assert.equal(result.passed, false);
            assert.match(result.violations.skillPackContractViolations.join('\n'), diagnostic);
            assert.match(result.violations.skillsIndexContractViolations.join('\n'), diagnostic);
            assert.ok(result.totalViolationCount >= 2);
        } finally {
            cleanupVerifyTempDir(tmpDir);
        }
    });
}

test('runVerify reports missing garda.config.json in manifest contract violations', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        writeInitAnswersFixture(tmpDir);

        const result = runVerify({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json'
        });

        assert.ok(
            result.violations.manifestContractViolations.some(
                (violation) => violation.includes('live/config/garda.config.json') && violation.includes('missing')
            )
        );
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('runVerify reports missing runtime-retention.json in manifest contract violations', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        writeInitAnswersFixture(tmpDir);

        const result = runVerify({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json'
        });

        assert.ok(
            result.violations.manifestContractViolations.some(
                (violation) => violation.includes('live/config/runtime-retention.json') && violation.includes('missing')
            )
        );
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('runVerify tolerates missing optional-skill-selection-policy.json for backward-compatible workspaces', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        writeInitAnswersFixture(tmpDir);

        const result = runVerify({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json'
        });

        assert.ok(
            !result.violations.manifestContractViolations.some(
                (violation) => violation.includes('live/config/optional-skill-selection-policy.json') && violation.includes('missing')
            )
        );
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('runVerify reports missing optional-skill-selection-policy.json when root config maps it', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        writeInitAnswersFixture(tmpDir);
        const configDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'garda.config.json'), JSON.stringify({
            version: 1,
            configs: {
                'optional-skill-selection-policy': 'optional-skill-selection-policy.json'
            }
        }, null, 2), 'utf8');

        const result = runVerify({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json'
        });

        assert.ok(
            result.violations.manifestContractViolations.some(
                (violation) => violation.includes('live/config/optional-skill-selection-policy.json') && violation.includes('missing')
            )
        );
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('runVerify reports invalid garda.config.json content in manifest contract violations', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        writeInitAnswersFixture(tmpDir);
        const configDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'garda.config.json'), '{', 'utf8');

        const result = runVerify({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json'
        });

        assert.ok(
            result.violations.manifestContractViolations.some(
                (violation) => violation.includes('live/config/garda.config.json') && violation.includes('valid JSON')
            )
        );
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('formatVerifyResult includes diagnostic markers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    try {
        const result = runVerify({
            targetRoot: tmpDir,
            sourceOfTruth: 'Claude',
            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json'
        });
        const output = formatVerifyResult(result);
        assert.ok(output.includes('TargetRoot:'));
        assert.ok(output.includes('SourceOfTruth: Claude'));
        assert.ok(output.includes('MissingPathCount:'));
        assert.ok(output.includes('Verification failed'));
    } finally {
        cleanupVerifyTempDir(tmpDir);
    }
});

test('formatVerifyResult shows PASS when all checks pass', () => {
    const fakeResult = {
        passed: true,
        targetRoot: '/tmp/test',
        sourceOfTruth: 'Claude',
        canonicalEntrypoint: 'CLAUDE.md',
        bundleVersion: '1.0.0',
        requiredPathsChecked: 10,
        violations: {
            missingPaths: [],
            initAnswersContractViolations: [],
            versionContractViolations: [],
            reviewCapabilitiesContractViolations: [],
            pathsContractViolations: [],
            tokenEconomyContractViolations: [],
            outputFiltersContractViolations: [],
            skillPacksConfigContractViolations: [],
            skillsIndexConfigContractViolations: [],
            ruleFileViolations: [],
            templatePlaceholderViolations: [],
            commandsContractViolations: [],
            manifestContractViolations: [],
            coreRuleContractViolations: [],
            entrypointContractViolations: [],
            taskContractViolations: [],
            qwenSettingsViolations: [],
            skillsIndexContractViolations: [],
            skillPackContractViolations: [],
            gitignoreMissing: []
        },
        totalViolationCount: 0
    };

    const output = formatVerifyResult(fakeResult);
    assert.ok(output.includes('Verification: PASSED'));
    assert.ok(!output.includes('Verification failed'));

    const lines = output.split('\n');
    assert.ok(
        lines.indexOf('SkillsIndexConfigContractViolationCount: 0') < lines.indexOf('BundleVersion: 1.0.0'),
        'BundleVersion must stay after config violation counts'
    );
    assert.ok(
        lines.indexOf('BundleVersion: 1.0.0') < lines.indexOf('VersionContractViolationCount: 0'),
        'BundleVersion must stay before version violation count'
    );
});

/* ------------------------------------------------------------------ */
/*  formatVerifyResultCompact (T-019)                                 */
/* ------------------------------------------------------------------ */

test('formatVerifyResultCompact emits single line on success', () => {
    const fakeResult = {
        passed: true,
        targetRoot: '/tmp/test',
        sourceOfTruth: 'Claude',
        canonicalEntrypoint: 'CLAUDE.md',
        bundleVersion: '1.0.0',
        requiredPathsChecked: 10,
        violations: {
            missingPaths: [],
            initAnswersContractViolations: [],
            versionContractViolations: [],
            reviewCapabilitiesContractViolations: [],
            pathsContractViolations: [],
            tokenEconomyContractViolations: [],
            outputFiltersContractViolations: [],
            skillPacksConfigContractViolations: [],
            skillsIndexConfigContractViolations: [],
            ruleFileViolations: [],
            templatePlaceholderViolations: [],
            commandsContractViolations: [],
            manifestContractViolations: [],
            coreRuleContractViolations: [],
            entrypointContractViolations: [],
            taskContractViolations: [],
            qwenSettingsViolations: [],
            skillsIndexContractViolations: [],
            skillPackContractViolations: [],
            gitignoreMissing: []
        },
        totalViolationCount: 0
    };
    const output = formatVerifyResultCompact(fakeResult);
    assert.ok(!output.includes('\n'), 'Compact success output must be a single line');
    assert.ok(output.includes('Verification: PASSED'));
    assert.ok(output.includes('paths=10'));
    assert.ok(output.includes('violations=0'));
});

test('formatVerifyResultCompact emits full output on failure', () => {
    const fakeResult = {
        passed: false,
        targetRoot: '/tmp/test',
        sourceOfTruth: 'Claude',
        canonicalEntrypoint: 'CLAUDE.md',
        bundleVersion: '1.0.0',
        requiredPathsChecked: 10,
        violations: {
            missingPaths: ['some/path'],
            initAnswersContractViolations: [],
            versionContractViolations: [],
            reviewCapabilitiesContractViolations: [],
            pathsContractViolations: [],
            tokenEconomyContractViolations: [],
            outputFiltersContractViolations: [],
            skillPacksConfigContractViolations: [],
            skillsIndexConfigContractViolations: [],
            ruleFileViolations: [],
            templatePlaceholderViolations: [],
            commandsContractViolations: [],
            manifestContractViolations: [],
            coreRuleContractViolations: [],
            entrypointContractViolations: [],
            taskContractViolations: [],
            qwenSettingsViolations: [],
            skillsIndexContractViolations: [],
            skillPackContractViolations: [],
            gitignoreMissing: []
        },
        totalViolationCount: 1
    };
    const output = formatVerifyResultCompact(fakeResult);
    assert.ok(output.includes('Verification failed'), 'Compact failure must include full failure output');
    assert.ok(output.includes('MissingPathCount: 1'));
});
