import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runInit, mergeConfig, USAGE_CONTRACT_MARKERS } from '../../../src/materialization/init';
import { handleWorkflow } from '../../../src/cli/commands/workflow-command';
import { getLifecycleOperationLockPath } from '../../../src/lifecycle/common';
import { PROJECT_MEMORY_INIT_REFRESH_PROMPT } from '../../../src/core/project-memory-rollout';
import {
    UNCONFIGURED_COMPILE_GATE_COMMAND,
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND
} from '../../../src/core/constants';
import { reviewFindingsReportJsonSchema } from '../../../src/gates/review/review-findings-schema';
import { DEFAULT_REVIEW_TRIGGER_POLICY } from '../../../src/policy/review-trigger-policy';

function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'template'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

function setupTestWorkspace(bundleRoot: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-init-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });
    fs.copyFileSync(path.join(bundleRoot, 'VERSION'), path.join(bundle, 'VERSION'));
    copyDirRecursive(path.join(bundleRoot, 'template'), path.join(bundle, 'template'));
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'live'), { recursive: true });
    return { projectRoot: tmpDir, bundleRoot: bundle };
}

function copyDirRecursive(src: string, dst: string) {
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

function extractMarkdownSection(markdown: string, heading: string): string {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^## ${escapedHeading}\\r?\\n([\\s\\S]*?)(?=^## |\\Z)`, 'm').exec(markdown);
    return match ? match[1].trim() : '';
}

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function captureConsole<T>(run: () => T): { result: T; output: string } {
    const originalConsoleLog = console.log;
    const lines: string[] = [];
    console.log = (...items: unknown[]) => {
        lines.push(stripAnsi(items.join(' ')));
    };
    try {
        return {
            result: run(),
            output: lines.join('\n')
        };
    } finally {
        console.log = originalConsoleLog;
    }
}

function seedLifecycleOperationLock(projectRoot: string, pid: number, hostname: string = os.hostname()) {
    const lockPath = getLifecycleOperationLockPath(projectRoot);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid,
        hostname,
        operation: 'update',
        acquired_at_utc: '2026-04-06T00:00:00.000Z',
        target_root: path.resolve(projectRoot)
    }, null, 2), 'utf8');
    return lockPath;
}

describe('runInit', () => {
    const repoRoot = findRepoRoot();

    it('materializes all 12 rule files in live/docs/agent-rules', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            assert.equal(result.ruleFilesMaterialized, 12);
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/docs/agent-rules/00-core.md')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/docs/agent-rules/15-project-memory.md')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/docs/agent-rules/40-command-reference.md')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/docs/agent-rules/80-task-workflow.md')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/docs/agent-rules/90-skill-catalog.md')));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates active .agentignore block during init without replacing user content', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(projectRoot, '.agentignore'), 'coverage/\n', 'utf8');

            const first = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });
            const second = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const agentignore = fs.readFileSync(path.join(projectRoot, '.agentignore'), 'utf8');
            assert.equal(first.agentignoreUpdated, true);
            assert.equal(second.agentignoreUpdated, false);
            assert.ok(agentignore.startsWith('coverage/'));
            assert.equal((agentignore.match(/# Garda active-mode agent ignore/g) || []).length, 1);
            assert.ok(agentignore.includes('garda-agent-orchestrator/runtime/full-suite/'));
            assert.ok(!agentignore.includes('garda-agent-orchestrator/live/config/'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('applies language and brevity to 00-core.md', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'Russian',
                assistantBrevity: 'detailed',
                sourceOfTruth: 'Claude'
            });

            const coreContent = fs.readFileSync(
                path.join(bundleRoot, 'live/docs/agent-rules/00-core.md'), 'utf8'
            );
            assert.ok(coreContent.includes('Russian'));
            assert.ok(coreContent.includes('detailed'));
            assert.ok(!coreContent.includes('{{ASSISTANT_RESPONSE_LANGUAGE}}'));
            assert.ok(!coreContent.includes('{{ASSISTANT_RESPONSE_BREVITY}}'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('replaces obsolete legacy code-style bootstrap defaults with the promoted template contract', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const legacyRuleDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyRuleDir, { recursive: true });
            fs.writeFileSync(path.join(legacyRuleDir, '30-code-style.md'), [
                '# Code Style',
                '',
                '## Bootstrap Policy When Repository Is Empty',
                '- Keep the legacy bootstrap default for empty repositories.',
                '',
                '## Language-Specific Rules (Fill Only Relevant Sections)',
                '- Type strictness level and runtime validation strategy: `TODO`'
            ].join('\n'), 'utf8');

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const codeStyleContent = fs.readFileSync(
                path.join(bundleRoot, 'live/docs/agent-rules/30-code-style.md'),
                'utf8'
            );
            assert.ok(codeStyleContent.includes('## Comments'));
            assert.ok(!codeStyleContent.includes('## Bootstrap Policy When Repository Is Empty'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('migrates concise legacy code-style refinements into project-memory while promoting the template contract', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const legacyRuleDir = path.join(projectRoot, 'docs', 'agent-rules');
            fs.mkdirSync(legacyRuleDir, { recursive: true });
            fs.writeFileSync(path.join(legacyRuleDir, '30-code-style.md'), [
                '# Code Style',
                '',
                '## Bootstrap Policy When Repository Is Empty',
                '- Keep the legacy bootstrap default for empty repositories.',
                '',
                '## Language-Specific Rules (Fill Only Relevant Sections)',
                '- Type strictness level and runtime validation strategy: `TODO`',
                '',
                '## Team Conventions',
                '- Prefer domain event names that read like past-tense business facts.'
            ].join('\n'), 'utf8');

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const codeStyleContent = fs.readFileSync(
                path.join(bundleRoot, 'live/docs/agent-rules/30-code-style.md'),
                'utf8'
            );
            const conventionsContent = fs.readFileSync(
                path.join(bundleRoot, 'live/docs/project-memory/conventions.md'),
                'utf8'
            );

            assert.ok(codeStyleContent.includes('## Comments'));
            assert.ok(!codeStyleContent.includes('## Bootstrap Policy When Repository Is Empty'));
            assert.ok(conventionsContent.includes('## Team Conventions'));
            assert.ok(conventionsContent.includes('Prefer domain event names that read like past-tense business facts.'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });



    it('preserves live code-style refinements when project-memory does not exist yet', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const liveRuleDir = path.join(bundleRoot, 'live', 'docs', 'agent-rules');
            fs.mkdirSync(liveRuleDir, { recursive: true });
            fs.writeFileSync(path.join(liveRuleDir, '30-code-style.md'), [
                '# Code Style',
                '',
                '## Team Conventions',
                '- Prefer domain event names that read like past-tense business facts.'
            ].join('\n'), 'utf8');

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const codeStyleContent = fs.readFileSync(
                path.join(bundleRoot, 'live/docs/agent-rules/30-code-style.md'),
                'utf8'
            );

            assert.ok(codeStyleContent.includes('## Team Conventions'));
            assert.ok(codeStyleContent.includes('Prefer domain event names that read like past-tense business facts.'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('keeps code-style refinements while picking up later template updates on rerun', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const projectMemoryDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), projectMemoryDir);
            fs.writeFileSync(
                path.join(projectMemoryDir, 'conventions.md'),
                '# Conventions\n\n## Existing Team Conventions\n- Preserve existing project-memory ownership.\n',
                'utf8'
            );

            const liveRulePath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '30-code-style.md');
            fs.mkdirSync(path.dirname(liveRulePath), { recursive: true });
            fs.writeFileSync(liveRulePath, [
                '# Code Style',
                '',
                '## Team Conventions',
                '- Prefer domain event names that read like past-tense business facts.',
                '- Always use strict equality checks.',
                '- Prefer early returns to reduce nesting.',
                '- Keep functions small and focused.'
            ].join('\n'), 'utf8');

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const templateRulePath = path.join(bundleRoot, 'template', 'docs', 'agent-rules', '30-code-style.md');
            const updatedTemplate = fs.readFileSync(templateRulePath, 'utf8').replace(
                '- Remove unused language or framework placeholders instead of leaving stale',
                '- Prefer contract tests for cross-boundary adapters before wiring them into handlers.\n- Remove unused language or framework placeholders instead of leaving stale'
            );
            fs.writeFileSync(templateRulePath, updatedTemplate, 'utf8');

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const codeStyleContent = fs.readFileSync(liveRulePath, 'utf8');
            assert.ok(codeStyleContent.includes('## Team Conventions'));
            assert.ok(codeStyleContent.includes('Prefer domain event names that read like past-tense business facts.'));
            assert.ok(!codeStyleContent.includes('Prefer contract tests for cross-boundary adapters before wiring them into handlers.'));

            const styleTemplate = fs.readFileSync(path.join(bundleRoot, 'live/docs/agent-rules/30-code-style.template.md'), 'utf8');
            assert.ok(styleTemplate.includes('Prefer contract tests for cross-boundary adapters before wiring them into handlers.'));

            const initReport = fs.readFileSync(path.join(bundleRoot, 'live/init-report.md'), 'utf8');
            assert.ok(initReport.includes('## Update Notices'));
            assert.ok(initReport.includes('**Style Guidance Update**'));
            assert.ok(initReport.includes('live/docs/agent-rules/30-code-style.template.md'));
            assert.ok(initReport.includes('live/docs/project-memory/conventions.template.md'));

            const memoryTemplatePath = path.join(bundleRoot, 'live/docs/project-memory/conventions.template.md');
            assert.ok(fs.existsSync(memoryTemplatePath));
            fs.writeFileSync(
                memoryTemplatePath,
                '# Local Adoption Notes\n\n## Notes\n- Keep this local comparison note.\n',
                'utf8'
            );

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const memoryTemplate = fs.readFileSync(memoryTemplatePath, 'utf8');
            assert.ok(memoryTemplate.includes('Keep this local comparison note.'));
            assert.ok(!memoryTemplate.includes('Prefer contract tests for cross-boundary adapters before wiring them into handlers.'));

            const projectMemorySummary = fs.readFileSync(
                path.join(bundleRoot, 'live/docs/agent-rules/15-project-memory.md'),
                'utf8'
            );
            assert.ok(!projectMemorySummary.includes('conventions.template.md'));
            assert.ok(!projectMemorySummary.includes('Fresh installs start with the seed conventions below;'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves legacy docs code-style refinements when project-memory already has content', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const projectMemoryDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            copyDirRecursive(path.join(bundleRoot, 'template', 'docs', 'project-memory'), projectMemoryDir);
            fs.writeFileSync(
                path.join(projectMemoryDir, 'conventions.md'),
                '# Conventions\n\n## Existing Team Conventions\n- Keep established project-memory notes.\n',
                'utf8'
            );

            const legacyRulePath = path.join(projectRoot, 'docs', 'agent-rules', '30-code-style.md');
            fs.mkdirSync(path.dirname(legacyRulePath), { recursive: true });
            fs.writeFileSync(legacyRulePath, [
                '# Code Style',
                '',
                '## Team Conventions',
                '- Prefer domain event names that read like past-tense business facts.',
                '- Keep legacy docs style guidance until manually adopted into project-memory.'
            ].join('\n'), 'utf8');

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const liveRulePath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '30-code-style.md');
            const liveRuleContent = fs.readFileSync(liveRulePath, 'utf8');
            assert.ok(liveRuleContent.includes('Prefer domain event names that read like past-tense business facts.'));
            assert.ok(liveRuleContent.includes('Keep legacy docs style guidance until manually adopted into project-memory.'));

            const conventionsContent = fs.readFileSync(path.join(projectMemoryDir, 'conventions.md'), 'utf8');
            assert.ok(conventionsContent.includes('Keep established project-memory notes.'));

            const initReport = fs.readFileSync(path.join(bundleRoot, 'live/init-report.md'), 'utf8');
            assert.ok(initReport.includes('## Update Notices'));
            assert.ok(initReport.includes('**Style Guidance Update**'));

            const memoryTemplatePath = path.join(projectMemoryDir, 'conventions.template.md');
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/docs/agent-rules/30-code-style.template.md')));
            assert.ok(fs.existsSync(memoryTemplatePath));
            assert.ok(fs.existsSync(path.join(projectMemoryDir, '.legacy-style-contract')));

            fs.writeFileSync(
                memoryTemplatePath,
                '# Local Legacy Adoption Notes\n\n## Notes\n- Preserve local legacy comparison notes.\n',
                'utf8'
            );

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const memoryTemplate = fs.readFileSync(memoryTemplatePath, 'utf8');
            assert.ok(memoryTemplate.includes('Preserve local legacy comparison notes.'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('copies support directories to live/', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const userSchemaPath = path.join(bundleRoot, 'live/schemas/local-review-extension.schema.json');
            fs.mkdirSync(path.dirname(userSchemaPath), { recursive: true });
            fs.writeFileSync(userSchemaPath, '{"title":"user-owned extension"}\n', 'utf8');

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            assert.ok(result.supportDirectoriesSynced > 0);
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/config')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/skills')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/schemas/review-findings-report.schema.json')));
            assert.ok(fs.existsSync(path.join(bundleRoot, 'live/skills/orchestration/skill.json')));
            assert.deepEqual(
                JSON.parse(fs.readFileSync(
                    path.join(bundleRoot, 'live/schemas/review-findings-report.schema.json'),
                    'utf8'
                )),
                reviewFindingsReportJsonSchema
            );
            assert.equal(
                fs.readFileSync(userSchemaPath, 'utf8'),
                '{"title":"user-owned extension"}\n'
            );
            const pathsConfig = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'live/config/paths.json'), 'utf8'));
            assert.deepEqual(
                pathsConfig.triggers.test_refactor_structural,
                DEFAULT_REVIEW_TRIGGER_POLICY.test_refactor_structural_path_regexes
            );
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('creates reporting files', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            fs.mkdirSync(path.join(projectRoot, 'docs', 'agent-rules'), { recursive: true });
            fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Legacy\n', 'utf8');
            fs.writeFileSync(path.join(projectRoot, 'docs', 'agent-rules', '10-context.md'), '# Context\n', 'utf8');
            fs.writeFileSync(path.join(projectRoot, 'docs', 'overview.md'), '# Overview\n', 'utf8');

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            assert.ok(fs.existsSync(result.initReportPath));
            assert.ok(fs.existsSync(result.sourceInventoryPath));
            assert.ok(fs.existsSync(result.projectDiscoveryPath));
            assert.ok(fs.existsSync(result.usagePath));

            const report = fs.readFileSync(result.initReportPath, 'utf8');
            const inventory = fs.readFileSync(result.sourceInventoryPath, 'utf8');
            const discovery = fs.readFileSync(result.projectDiscoveryPath, 'utf8');
            assert.ok(report.includes('# Init Report'));
            assert.ok(report.includes('Rule Source Mapping'));
            assert.ok(report.includes('Legacy docs discovered in `docs/agent-rules`: 1 files'));
            assert.ok(inventory.includes('`AGENTS.md` : FOUND'));
            assert.ok(inventory.includes('`docs/agent-rules` : FOUND (files=1)'));
            assert.ok(discovery.includes('## Stack Evidence'));
            assert.ok(discovery.includes('## Runtime Path Hints'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('sets token economy enabled flag in config', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude',
                tokenEconomyEnabled: false
            });

            const configPath = path.join(bundleRoot, 'live/config/token-economy.json');
            assert.ok(fs.existsSync(configPath));
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            assert.equal(config.enabled, false);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('materializes strict_sequential review_execution_policy for a fresh bundle', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const workflowConfig = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
                'utf8'
            ));
            assert.deepEqual(workflowConfig.review_execution_policy, {
                mode: 'strict_sequential'
            });
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('materializes project-memory maintenance update mode for a fresh bundle', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const workflowConfig = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
                'utf8'
            ));
            assert.deepEqual(workflowConfig.project_memory_maintenance, {
                enabled: true,
                mode: 'update',
                run_before_final_closeout: true,
                require_user_approval_for_writes: true,
                max_compact_summary_chars: 12000,
                read_strategy: 'index_first',
                impact_artifact_retention_days: 30
            });
            assert.equal(result.projectMemoryMaintenanceSummaryLine, 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true');

            const initReport = fs.readFileSync(result.initReportPath, 'utf8');
            assert.ok(initReport.includes(`Project memory init/refresh prompt: ${PROJECT_MEMORY_INIT_REFRESH_PROMPT}`));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('keeps Java workspace full-suite config unconfigured and reports Gradle discovery', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(projectRoot, 'build.gradle.kts'), 'plugins {}\n', 'utf8');
            fs.writeFileSync(path.join(projectRoot, 'gradlew'), '#!/bin/sh\n', 'utf8');
            fs.writeFileSync(path.join(projectRoot, 'gradlew.bat'), '@echo off\r\n', 'utf8');

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const workflowConfig = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
                'utf8'
            ));
            const discovery = fs.readFileSync(result.projectDiscoveryPath, 'utf8');
            const commands = fs.readFileSync(
                path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
                'utf8'
            );
            const fullSuiteSection = extractMarkdownSection(discovery, 'Suggested Full-Suite Validation Command');
            const compileSection = extractMarkdownSection(discovery, 'Suggested Compile Gate Commands (Heuristic)');

            assert.equal(workflowConfig.full_suite_validation.command, UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND);
            assert.equal(workflowConfig.full_suite_validation.enabled, false);
            assert.equal(
                workflowConfig.compile_gate.command,
                process.platform === 'win32' ? '.\\gradlew.bat assemble' : './gradlew assemble'
            );
            assert.ok(discovery.includes('Java or JVM'));
            assert.ok(discovery.includes('`build.gradle.kts`'));
            assert.ok(fullSuiteSection.includes('`' + (process.platform === 'win32' ? '.\\gradlew.bat test' : './gradlew test') + '`'));
            assert.ok(compileSection.includes('`' + (process.platform === 'win32' ? '.\\gradlew.bat assemble' : './gradlew assemble') + '`'));
            assert.ok(commands.includes(process.platform === 'win32' ? '.\\gradlew.bat assemble' : './gradlew assemble'));
            assert.equal(/### Compile Gate \(Mandatory\)\r?\n```bash\r?\nnpm run build\r?\n```/.test(commands), false);
            assert.ok(commands.includes('Use the command detected in `garda-agent-orchestrator/live/project-discovery.md`'));
            assert.ok(!commands.includes('### Test\r\n```bash\r\nnpm test'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('materializes a composed fast compile gate for Maven backend and frontend workspaces', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            fs.mkdirSync(path.join(projectRoot, 'backend'), { recursive: true });
            fs.mkdirSync(path.join(projectRoot, 'frontend'), { recursive: true });
            fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true });
            fs.writeFileSync(path.join(projectRoot, 'backend', 'pom.xml'), '<project />', 'utf8');
            fs.writeFileSync(path.join(projectRoot, 'frontend', 'package.json'), JSON.stringify({
                scripts: { build: 'vite build', test: 'vitest run' }
            }), 'utf8');
            fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
                scripts: { build: 'bash ./scripts/build.sh -f' }
            }), 'utf8');
            fs.writeFileSync(path.join(projectRoot, 'scripts', 'build.sh'), '#!/bin/sh\n', 'utf8');

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const expectedCommand = 'npm --prefix frontend run build && mvn -f backend/pom.xml compile';
            const workflowConfig = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
                'utf8'
            ));
            const discovery = fs.readFileSync(result.projectDiscoveryPath, 'utf8');
            const commands = fs.readFileSync(
                path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
                'utf8'
            );
            const workflowShow = captureConsole(() => handleWorkflow([
                'show',
                '--bundle-root',
                bundleRoot
            ], { name: 'garda-agent-orchestrator', version: 'test' }));

            assert.equal(workflowConfig.compile_gate.command, expectedCommand);
            assert.ok(discovery.includes(`\`${expectedCommand}\``));
            assert.match(
                commands,
                new RegExp(`### Compile Gate \\(Mandatory\\)\\r?\\n\`\`\`bash\\r?\\n${expectedCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n\`\`\``)
            );
            assert.ok(workflowShow.output.includes(`CompileGateCommand: ${expectedCommand}`));
            assert.ok(!commands.includes('build.sh -f'));
            assert.ok(!workflowShow.output.includes('build.sh -f'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('keeps unknown-stack workspace full-suite config unconfigured', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Unknown project\n', 'utf8');

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const workflowConfig = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
                'utf8'
            ));
            const discovery = fs.readFileSync(result.projectDiscoveryPath, 'utf8');

            assert.equal(workflowConfig.full_suite_validation.command, UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND);
            assert.equal(workflowConfig.full_suite_validation.enabled, false);
            assert.equal(workflowConfig.compile_gate.command, UNCONFIGURED_COMPILE_GATE_COMMAND);
            assert.ok(discovery.includes('No deterministic full-suite command detected yet.'));
            const commands = fs.readFileSync(
                path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
                'utf8'
            );
            assert.ok(commands.includes(UNCONFIGURED_COMPILE_GATE_COMMAND));
            assert.equal(/### Compile Gate \(Mandatory\)\r?\n```bash\r?\nnpm run build\r?\n```/.test(commands), false);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('syncs configured workflow compile command into template command guidance', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const configuredCommand = 'tsc --noEmit';
            fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Unknown project\n', 'utf8');
            fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
            fs.writeFileSync(path.join(bundleRoot, 'live', 'config', 'workflow-config.json'), JSON.stringify({
                compile_gate: {
                    command: configuredCommand
                }
            }, null, 2), 'utf8');
            fs.mkdirSync(path.join(bundleRoot, 'live', 'docs', 'agent-rules'), { recursive: true });
            fs.writeFileSync(
                path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
                [
                    '# Commands',
                    '',
                    '### Compile Gate (Mandatory)',
                    '```bash',
                    UNCONFIGURED_COMPILE_GATE_COMMAND,
                    '```',
                    ''
                ].join('\n'),
                'utf8'
            );

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const workflowConfig = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'workflow-config.json'),
                'utf8'
            ));
            const commands = fs.readFileSync(
                path.join(bundleRoot, 'live', 'docs', 'agent-rules', '40-commands.md'),
                'utf8'
            );
            assert.equal(workflowConfig.compile_gate.command, configuredCommand);
            assert.match(
                commands,
                /### Compile Gate \(Mandatory\)\r?\n```bash\r?\ntsc --noEmit\r?\n```/
            );
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('syncs root .gitignore without root reviewer scratch during standalone init', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
            assert.ok(gitignore.includes('# garda-agent-orchestrator managed ignores'));
            assert.ok(gitignore.includes('garda-agent-orchestrator/'));
            assert.ok(gitignore.includes('.agentignore'));
            assert.ok(gitignore.includes('TASK.md'));
            assert.ok(!gitignore.includes('.review-temp/'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('rewrites garda.config.json from the canonical template on reinit', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const gardaConfigPath = path.join(bundleRoot, 'live', 'config', 'garda.config.json');
            const templateConfigPath = path.join(bundleRoot, 'template', 'config', 'garda.config.json');
            const modifiedConfig = {
                version: 99,
                configs: {
                    'review-capabilities': '../custom/review-capabilities.json',
                    'token-economy': 'token-economy.json'
                },
                custom: true
            };

            fs.writeFileSync(gardaConfigPath, JSON.stringify(modifiedConfig, null, 2), 'utf8');

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const materializedConfig = JSON.parse(fs.readFileSync(gardaConfigPath, 'utf8'));
            const templateConfig = JSON.parse(fs.readFileSync(templateConfigPath, 'utf8'));
            assert.deepEqual(materializedConfig, templateConfig);
            assert.equal(result.gardaConfigMergeStatus, 'canonical_template_reapplied_existing_values_replaced');

            const report = fs.readFileSync(result.initReportPath, 'utf8');
            assert.ok(report.includes('Root config manifest sync policy: rewrite the canonical root manifest from template on every init/update.'));
            assert.ok(report.includes('Root config manifest merge status: canonical_template_reapplied_existing_values_replaced'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves runtime-retention values and reports runtime-retention merge status on reinit', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const runtimeRetentionPath = path.join(bundleRoot, 'live', 'config', 'runtime-retention.json');
            fs.writeFileSync(runtimeRetentionPath, JSON.stringify({
                version: 1,
                healthy_done: {
                    compact_after_days: 45
                }
            }, null, 2), 'utf8');

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const materializedConfig = JSON.parse(fs.readFileSync(runtimeRetentionPath, 'utf8'));
            assert.equal(materializedConfig.healthy_done.compact_after_days, 45);
            assert.equal(materializedConfig.purge.require_confirm, true);
            assert.equal(materializedConfig.daily_maintenance.dry_run, true);
            assert.equal(result.runtimeRetentionConfigMergeStatus, 'existing_values_preserved_and_missing_keys_filled');

            const report = fs.readFileSync(result.initReportPath, 'utf8');
            assert.ok(report.includes('Runtime retention config sync policy: preserve existing live values, fill missing keys from template.'));
            assert.ok(report.includes('Runtime retention config merge status: existing_values_preserved_and_missing_keys_filled'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves runtime-retention mode choices and legacy preview on reinit', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const options = { targetRoot: projectRoot, bundleRoot, sourceOfTruth: 'Claude' as const };
            runInit(options);
            const configPath = path.join(bundleRoot, 'live/config/runtime-retention.json');
            const fresh = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            assert.equal(fresh.daily_maintenance.enabled, true);
            assert.equal(fresh.daily_maintenance.dry_run, false);
            assert.equal(fresh.purge.require_confirm, false);
            for (const preview of [undefined, true, false]) {
                const legacy = JSON.parse(JSON.stringify(fresh));
                if (preview === undefined) delete legacy.daily_maintenance.dry_run;
                else legacy.daily_maintenance.dry_run = preview;
                fs.writeFileSync(configPath, JSON.stringify(legacy));
                runInit(options);
                const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                assert.equal(updated.daily_maintenance.dry_run, preview ?? true);
                assert.equal(updated.purge.require_confirm, false);
            }
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('materializes review catalog and preserves custom definitions on reinit', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const catalogPath = path.join(bundleRoot, 'live', 'config', 'review-catalog.json');
            const defaultCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
            assert.deepEqual(defaultCatalog, {
                version: 1,
                custom_review_types: []
            });
            assert.deepEqual(
                defaultCatalog,
                JSON.parse(fs.readFileSync(path.join(repoRoot, 'template', 'config', 'review-catalog.json'), 'utf8'))
            );

            const customCatalog = {
                version: 1,
                custom_review_types: [{
                    id: 'architecture-boundary',
                    display_label: 'Architecture boundary review',
                    enabled_by_default: false,
                    skill_id: 'security-review',
                    trigger: {
                        mode: 'signals',
                        signal_ids: ['scope:architecture']
                    },
                    coverage_category_ids: ['maintainability'],
                    reviewer_role: {
                        role_id: 'architecture-specialist',
                        focus_tags: ['boundaries']
                    }
                }]
            };
            fs.writeFileSync(catalogPath, JSON.stringify(customCatalog, null, 2), 'utf8');

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            assert.deepEqual(JSON.parse(fs.readFileSync(catalogPath, 'utf8')), customCatalog);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves optional skill selection policy values and custom fields on reinit', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const policyPath = path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json');
            fs.writeFileSync(policyPath, JSON.stringify({
                version: 1,
                mode: 'mandatory',
                local_note: 'keep local policy metadata'
            }, null, 2), 'utf8');

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const materializedConfig = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
            assert.equal(materializedConfig.mode, 'mandatory');
            assert.equal(materializedConfig.local_note, 'keep local policy metadata');
            assert.equal(result.optionalSkillSelectionPolicyConfigMergeStatus, 'existing_values_preserved_and_missing_keys_filled');

            const report = fs.readFileSync(result.initReportPath, 'utf8');
            assert.ok(report.includes('Optional skill selection policy config sync policy: preserve existing live values and fill missing keys from template.'));
            assert.ok(report.includes('Optional skill selection policy config merge status: existing_values_preserved_and_missing_keys_filled'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('fails when another live lifecycle operation lock exists', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const lockPath = seedLifecycleOperationLock(projectRoot, process.pid);

            assert.throws(() => runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            }), /Another lifecycle operation is already running/);
            assert.ok(fs.existsSync(lockPath), 'live lock must be preserved');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('reclaims stale lifecycle operation lock before init', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const lockPath = seedLifecycleOperationLock(projectRoot, 99999999);

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            assert.equal(result.ruleFilesMaterialized, 12);
            assert.ok(!fs.existsSync(lockPath), 'stale lock should be removed after successful init');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('throws for unsupported brevity', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            assert.throws(() => runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantBrevity: 'invalid'
            }), /Unsupported AssistantBrevity/);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('seeds USAGE.md with canonical entrypoint', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex'
            });

            const usage = fs.readFileSync(path.join(bundleRoot, 'live/USAGE.md'), 'utf8');
            assert.ok(usage.includes('AGENTS.md'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('renders navigator-first profile and config guidance in USAGE.md', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Codex'
            });

            const usage = fs.readFileSync(path.join(bundleRoot, 'live/USAGE.md'), 'utf8');
            for (const marker of Object.values(USAGE_CONTRACT_MARKERS)) {
                assert.ok(usage.includes(marker), `USAGE.md should include ${marker}`);
            }
            assert.ok(usage.includes('Path: `garda-agent-orchestrator/live/USAGE.md`'));
            assert.ok(usage.includes('Execute task <task-id> from TASK.md strictly through the orchestrator.'));
            assert.ok(usage.includes('next-step "<task-id>" --repo-root "."'));
            assert.ok(usage.includes('Garda captures my mind'));
            assert.ok(usage.includes('garda-agent-orchestrator/live/config/profiles.json'));
            assert.ok(usage.includes('node garda-agent-orchestrator/bin/garda.js profile current --target-root "."'));
            assert.ok(usage.includes('garda-agent-orchestrator/live/config/workflow-config.json'));
            assert.ok(usage.includes('workflow show --target-root "."'));
            assert.ok(usage.includes('garda-agent-orchestrator/live/config/review-capabilities.json'));
            assert.ok(usage.includes('review-capabilities list|enable|disable'));
            assert.ok(usage.includes('garda-agent-orchestrator/live/config/review-catalog.json'));
            assert.ok(usage.includes('review-catalog list|show|explain|validate'));
            assert.ok(usage.includes('Missing catalogs remain legacy-compatible.'));
            assert.ok(usage.includes('affect future task snapshots only'));
            assert.ok(usage.includes('ordinary_doc_paths'));
            assert.ok(usage.includes('Full repository test validation after each task is currently disabled.'));
            assert.ok(usage.includes('garda-agent-orchestrator/'));
            assert.ok(!usage.includes('Use `depth=<1|2|3>` only when you intentionally want a one-run override'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('synchronizes optional review capabilities from live specialist skills', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const apiSkillRoot = path.join(bundleRoot, 'live', 'skills', 'api-contract-review');
            const testSkillRoot = path.join(bundleRoot, 'live', 'skills', 'testing-strategy');
            fs.mkdirSync(apiSkillRoot, { recursive: true });
            fs.mkdirSync(testSkillRoot, { recursive: true });
            fs.writeFileSync(path.join(apiSkillRoot, 'SKILL.md'), '# api-contract-review\n', 'utf8');
            fs.writeFileSync(path.join(testSkillRoot, 'SKILL.md'), '# testing-strategy\n', 'utf8');

            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const capabilities = JSON.parse(fs.readFileSync(
                path.join(bundleRoot, 'live', 'config', 'review-capabilities.json'),
                'utf8'
            ));
            assert.equal(capabilities.api, true);
            assert.equal(capabilities.test, true);
            assert.equal(capabilities.dependency, true);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('seeds project-memory from template on first install', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            assert.ok(fs.existsSync(pmDir), 'project-memory should be seeded from template on first install');
            assert.ok(fs.existsSync(path.join(pmDir, 'README.md')), 'project-memory/README.md should exist');
            assert.ok(fs.existsSync(path.join(pmDir, 'compact.md')), 'project-memory/compact.md should exist');
            assert.ok(fs.existsSync(path.join(pmDir, 'module-map.md')), 'project-memory/module-map.md should exist');
            assert.ok(fs.existsSync(path.join(pmDir, 'commands.md')), 'project-memory/commands.md should exist');
            assert.ok(fs.existsSync(path.join(pmDir, 'risks.md')), 'project-memory/risks.md should exist');
            assert.equal(result.seedOnlyDirectoriesSeeded, 1);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('adds missing project-memory seed files without overwriting user-owned files', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'README.md'), '# Custom Project Memory\n', 'utf8');
            fs.writeFileSync(path.join(pmDir, 'context.md'), '# Custom Context\nKeep this local fact.\n', 'utf8');

            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            assert.equal(result.seedOnlyDirectoriesSeeded, 0);
            assert.equal(fs.readFileSync(path.join(pmDir, 'README.md'), 'utf8'), '# Custom Project Memory\n');
            assert.equal(fs.readFileSync(path.join(pmDir, 'context.md'), 'utf8'), '# Custom Context\nKeep this local fact.\n');
            assert.ok(fs.existsSync(path.join(pmDir, 'compact.md')));
            assert.ok(fs.existsSync(path.join(pmDir, 'module-map.md')));
            assert.ok(fs.existsSync(path.join(pmDir, 'commands.md')));
            assert.ok(fs.existsSync(path.join(pmDir, 'risks.md')));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('preserves existing project-memory on reinit', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First init — seeds project-memory
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // Write user content into project-memory
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.writeFileSync(path.join(pmDir, 'user-notes.md'), '# User Notes\nImportant decision.');

            // Second init (simulating reinit/update)
            const result2 = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // User content must survive
            assert.ok(fs.existsSync(path.join(pmDir, 'user-notes.md')),
                'user-notes.md must survive reinit');
            assert.equal(
                fs.readFileSync(path.join(pmDir, 'user-notes.md'), 'utf8'),
                '# User Notes\nImportant decision.'
            );
            assert.equal(result2.seedOnlyDirectoriesSeeded, 0,
                'project-memory should not be re-seeded when already present');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('does not collaterally affect project-memory via docs support directory sync', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First init
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // Add user file in project-memory
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.writeFileSync(path.join(pmDir, 'custom.md'), 'custom');

            // Second init — support dirs (docs/changes, docs/reviews, docs/tasks) get re-synced
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // project-memory/custom.md must still be there
            assert.ok(fs.existsSync(path.join(pmDir, 'custom.md')),
                'docs/project-memory must not be affected by docs/* support directory sync');
            assert.equal(fs.readFileSync(path.join(pmDir, 'custom.md'), 'utf8'), 'custom');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('generates 15-project-memory.md with DO NOT EDIT header on init', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const summaryPath = path.join(bundleRoot, 'live', 'docs', 'agent-rules', '15-project-memory.md');
            assert.ok(fs.existsSync(summaryPath), '15-project-memory.md must exist after init');
            const content = fs.readFileSync(summaryPath, 'utf8');
            assert.ok(content.includes('DO NOT EDIT'), 'must have DO NOT EDIT header');
            assert.ok(content.includes('15 · Project Memory Summary'), 'must have title');
            assert.ok(content.includes('Generated at:'), 'must have timestamp');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('writes project-memory bootstrap report on init', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const reportPath = path.join(bundleRoot, 'runtime', 'project-memory', 'bootstrap-report.json');
            assert.equal(result.projectMemoryBootstrapReportPath, reportPath);
            assert.ok(fs.existsSync(reportPath), 'bootstrap report must be written');

            const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            assert.equal(report.schema_version, 1);
            assert.equal(report.project_memory.read_strategy, 'index_first');
            assert.ok(report.project_memory.read_first.includes('live/docs/project-memory/README.md'));
            assert.ok(report.project_memory.read_first.includes('live/docs/project-memory/compact.md'));
            assert.equal(report.validation.mode, 'check');
            assert.equal(report.generated_summary.path, 'live/docs/agent-rules/15-project-memory.md');
            assert.match(String(report.generated_summary.sha256), /^[a-f0-9]{64}$/);
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('regenerates 15-project-memory.md with user content on reinit', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // First init — seeds template project-memory
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            // Add real content to project-memory
            const pmDir = path.join(bundleRoot, 'live', 'docs', 'project-memory');
            fs.writeFileSync(path.join(pmDir, 'context.md'),
                '# Context\n\n## Domain\n\nB2B logistics SaaS.\n', 'utf8');

            // Second init (reinit)
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const content = fs.readFileSync(
                path.join(bundleRoot, 'live', 'docs', 'agent-rules', '15-project-memory.md'), 'utf8'
            );
            assert.ok(content.includes('B2B logistics SaaS'), 'summary must contain user content');
            assert.ok(content.includes('Provenance'), 'summary must include provenance table');
            assert.ok(content.includes('docs/project-memory/context.md'), 'provenance must reference source');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('generates placeholder stub when project-memory has only templates', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            // Init seeds template files which have only HTML comment placeholders
            runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const content = fs.readFileSync(
                path.join(bundleRoot, 'live', 'docs', 'agent-rules', '15-project-memory.md'), 'utf8'
            );
            assert.ok(content.includes('DO NOT EDIT'));
            assert.ok(content.includes('placeholder templates') || content.includes('no content'),
                'stub must indicate placeholder state');
            assert.ok(content.includes('Read-first files: `README.md`, then `compact.md`.'));
            assert.ok(content.includes('`module-map.md`'));
            assert.ok(content.includes('`commands.md`'));
            assert.ok(content.includes('`risks.md`'));
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });

    it('includes 15-project-memory.md in ruleSourceMap as generated', () => {
        const { projectRoot, bundleRoot } = setupTestWorkspace(repoRoot);
        try {
            const result = runInit({
                targetRoot: projectRoot,
                bundleRoot,
                assistantLanguage: 'English',
                assistantBrevity: 'concise',
                sourceOfTruth: 'Claude'
            });

            const pmEntry = result.ruleSourceMap.find(e => e.ruleFile === '15-project-memory.md');
            assert.ok(pmEntry, '15-project-memory.md must be in ruleSourceMap');
            assert.equal(pmEntry.origin, 'generated');
            assert.equal(pmEntry.source, 'docs/project-memory/*');
        } finally {
            fs.rmSync(projectRoot, { recursive: true, force: true });
        }
    });
});

describe('mergeConfig', () => {
    it('preserves existing values over template', () => {
        const result = mergeConfig(
            { a: 1, b: 2, c: 3 },
            { a: 10, b: 20 }
        );
        assert.equal(result.a, 10);
        assert.equal(result.b, 20);
        assert.equal(result.c, 3);
    });

    it('fills missing keys from template', () => {
        const result = mergeConfig(
            { a: 1, b: 2 },
            { a: 10 }
        );
        assert.equal(result.b, 2);
    });

    it('preserves unknown keys from existing', () => {
        const result = mergeConfig(
            { a: 1 },
            { a: 10, custom: 'value' }
        );
        assert.equal(result.custom, 'value');
    });

    it('returns template copy when no existing', () => {
        const result = mergeConfig({ a: 1 }, null);
        assert.equal(result.a, 1);
    });

    it('deep merges nested objects', () => {
        const result = mergeConfig(
            { nested: { a: 1, b: 2 } },
            { nested: { a: 10 } }
        );
        assert.equal((result.nested as Record<string, unknown>).a, 10);
        assert.equal((result.nested as Record<string, unknown>).b, 2);
    });
});
