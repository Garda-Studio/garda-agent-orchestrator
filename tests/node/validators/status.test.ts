import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { seedCompiledRuntimeLayout } from '../bundle-source-fixtures';

import {
    getStatusSnapshot,
    getTaskCycleStatusSnapshot,
    formatStatusSnapshot,
    formatStatusSnapshotCompact,
    resolveInitAnswersPath
} from '../../../src/validators';
import { buildAgentInitOutput } from '../../../src/cli/commands/agent-init';
import { writeProtectedControlPlaneManifest } from '../../../src/gates/shared/helpers';
import { buildEventIntegrityHash } from '../../../src/gate-runtime/task-events';
import { quoteCommandValue } from '../../../src/core/command-quoting';
import { buildAgentInitializationRecoveryGuidance } from '../../../src/validators/status/status-recommendations';

const MANAGED_START = '<!-- garda-agent-orchestrator:managed-start -->';
const MANAGED_END = '<!-- garda-agent-orchestrator:managed-end -->';
const TEST_COMPILE_GATE_COMMAND = 'npm run build';

function writeStatusFixtureFile(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function cleanupStatusTempDir(tmpDir: string): void {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function makeCompliantEntrypoint(name: string): string {
    return [
        MANAGED_START,
        `# ${name}`,
        'This file is a redirect.',
        'Hard stop: open `.agents/workflows/start-task.md`.',
        MANAGED_END
    ].join('\n');
}

function seedBundleIdentity(bundlePath: string, packageName: string, cliEntrypoint: string) {
    writeStatusFixtureFile(path.join(bundlePath, 'MANIFEST.md'), '# Manifest\n');
    writeStatusFixtureFile(path.join(bundlePath, 'VERSION'), '1.0.0\n');
    writeStatusFixtureFile(
        path.join(bundlePath, 'package.json'),
        JSON.stringify({ name: packageName }, null, 2)
    );
    writeStatusFixtureFile(path.join(bundlePath, cliEntrypoint), '// cli\n');
}

function writeProfilesConfig(bundlePath: string, profileConfig: {
    active_profile: string;
    depth: number;
    review_remediation_mode_policy?: Record<string, unknown>;
}) {
    const profilesConfigPath = path.join(bundlePath, 'live', 'config', 'profiles.json');
    fs.mkdirSync(path.dirname(profilesConfigPath), { recursive: true });
    writeStatusFixtureFile(
        profilesConfigPath,
        JSON.stringify(
            {
                version: 1,
                active_profile: profileConfig.active_profile,
                built_in_profiles: {
                    [profileConfig.active_profile]: {
                        description: `${profileConfig.active_profile} profile`,
                        depth: profileConfig.depth,
                        review_policy: {},
                        ...(profileConfig.review_remediation_mode_policy ? {
                            review_remediation_mode_policy: profileConfig.review_remediation_mode_policy
                        } : {}),
                        token_economy: {
                            enabled: true,
                            strip_examples: true,
                            strip_code_blocks: true,
                            scoped_diffs: true,
                            compact_reviewer_output: true
                        },
                        skills: {}
                    }
                },
                user_profiles: {}
            },
            null,
            2
        )
    );
}

function makeActiveQueueTaskMd(rows: readonly string[]): string {
    return [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        ...rows,
        ''
    ].join('\n');
}

function seedInitializedWorkspace(tmpDir: string, collectedVia: string, options: Record<string, unknown> = {}) {
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const runtimePath = path.join(bundlePath, 'runtime');
    const liveRulesPath = path.join(bundlePath, 'live', 'docs', 'agent-rules');
    const activeAgentFiles = options.activeAgentFiles || 'AGENTS.md';
    seedBundleIdentity(bundlePath, 'garda-agent-orchestrator', path.join('bin', 'garda.js'));
    writeStatusFixtureFile(path.join(runtimePath, 'init-answers.json'), JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: collectedVia,
        ActiveAgentFiles: activeAgentFiles
    }));
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'USAGE.md'), '# Usage\n');
    writeStatusFixtureFile(path.join(tmpDir, 'TASK.md'), typeof options.taskMdContent === 'string'
        ? options.taskMdContent
        : '# Tasks\n');
    writeStatusFixtureFile(path.join(liveRulesPath, '40-commands.md'), 'npm install\nnpm test\nnpm run lint\n');
    if (options.workflowConfig !== false) {
        const workflowConfig = options.workflowConfig && typeof options.workflowConfig === 'object'
            ? options.workflowConfig
            : {
                compile_gate: {
                    command: TEST_COMPILE_GATE_COMMAND
                }
            };
        writeStatusFixtureFile(
            path.join(bundlePath, 'live', 'config', 'workflow-config.json'),
            JSON.stringify(workflowConfig, null, 2)
        );
    }

    // Create entrypoint files and shared router for compliance checks.
    writeStatusFixtureFile(
        path.join(tmpDir, '.agents', 'workflows', 'start-task.md'),
        [MANAGED_START, '# Start Task', 'Shared router.', MANAGED_END].join('\n')
    );
    const activeFilesList = typeof activeAgentFiles === 'string'
        ? activeAgentFiles.split(/[,;]+/).map((s: string) => s.trim()).filter(Boolean)
        : Array.isArray(activeAgentFiles) ? activeAgentFiles as string[] : ['AGENTS.md'];
    for (const entrypoint of activeFilesList) {
        writeStatusFixtureFile(
            path.join(tmpDir, entrypoint),
            makeCompliantEntrypoint(entrypoint)
        );
    }

    if (options.agentInitState) {
        const agentInitState = {
            OrdinaryDocPathsConfirmed: true,
            OrdinaryDocPaths: ['CHANGELOG.md'],
            LastSeededCompileGateCommand: null,
            LastSeededFullSuiteCommand: null,
            ProjectMemoryInitialized: true,
            ProjectMemoryValidated: true,
            ProjectMemoryMode: 'check',
            ProjectMemoryDir: 'live/docs/project-memory',
            ProjectMemoryReadFirst: [
                'live/docs/project-memory/README.md',
                'live/docs/project-memory/compact.md'
            ],
            ProjectMemorySummaryRule: 'live/docs/agent-rules/15-project-memory.md',
            ProjectMemoryBootstrapReport: 'runtime/project-memory/bootstrap-report.json',
            ProjectMemoryWarnings: [],
            ...options.agentInitState
        };
        writeStatusFixtureFile(
            path.join(runtimePath, 'agent-init-state.json'),
            JSON.stringify(agentInitState)
        );
    }
}

function writeIntegrityTaskModeEvent(timelinePath: string, taskId: string, message = 'Task mode entered.') {
    const taskModeEvent: Record<string, unknown> = {
        timestamp_utc: '2026-03-28T10:00:00.000Z',
        task_id: taskId,
        event_type: 'TASK_MODE_ENTERED',
        outcome: 'PASS',
        actor: 'gate',
        message,
        details: {},
        integrity: {
            schema_version: 1,
            task_sequence: 1,
            prev_event_sha256: null,
            event_sha256: ''
        }
    };
    (taskModeEvent.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(taskModeEvent);
    writeStatusFixtureFile(timelinePath, JSON.stringify(taskModeEvent) + '\n');
}

function writeScopeBudgetPreflight(
    bundlePath: string,
    taskId: string,
    changedLinesTotal: number,
    options: {
        changedFilesCount?: number;
        effectiveChangedFilesCount?: number;
        effectiveChangedLinesTotal?: number;
        uiI18nCompanionScope?: boolean;
    } = {}
): void {
    const metrics: Record<string, unknown> = {
        changed_files_count: options.changedFilesCount ?? 1,
        changed_lines_total: changedLinesTotal,
        changed_files_sha256: 'changed-files',
        scope_sha256: 'scope',
        scope_content_sha256: 'content'
    };
    if (typeof options.effectiveChangedFilesCount === 'number') {
        metrics.review_trigger_effective_changed_files_count = options.effectiveChangedFilesCount;
    }
    if (typeof options.effectiveChangedLinesTotal === 'number') {
        metrics.review_trigger_effective_changed_lines_total = options.effectiveChangedLinesTotal;
    }
    const payload: Record<string, unknown> = {
        task_id: taskId,
        mode: 'FULL_PATH',
        detection_source: 'explicit_changed_files',
        changed_files: ['src/example.ts'],
        metrics,
        required_reviews: {
            code: true
        },
        budget_forecast: {
            required_reviews: ['code'],
            total_estimated_review_tokens: 1000
        },
        profile_selection: {
            task_profile: 'strict',
            effective_profile: 'strict'
        }
    };
    if (options.uiI18nCompanionScope) {
        payload.triggers = {
            ui_i18n_companion_scope: true,
            ui_i18n_review_trigger_suppressed: true
        };
    }
    writeStatusFixtureFile(
        path.join(bundlePath, 'runtime', 'reviews', `${taskId}-preflight.json`),
        JSON.stringify(payload, null, 2)
    );
}

function seedMatchingSourceCheckoutParity(tmpDir: string) {
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    writeStatusFixtureFile(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'garda-agent-orchestrator', version: '1.0.0' }, null, 2)
    );
    writeStatusFixtureFile(path.join(tmpDir, 'VERSION'), '1.0.0\n');
    writeStatusFixtureFile(path.join(tmpDir, 'src', 'index.ts'), 'export {};\n');
    writeStatusFixtureFile(path.join(tmpDir, 'bin', 'garda.js'), '#!/usr/bin/env node\n');
    seedCompiledRuntimeLayout(tmpDir);
    seedCompiledRuntimeLayout(bundlePath);
    writeStatusFixtureFile(path.join(bundlePath, 'template', 'AGENTS.md'), '# template\n');
    writeStatusFixtureFile(path.join(bundlePath, 'template', 'entrypoints', 'canonical-rule-index.md'), '# template\n');
    writeStatusFixtureFile(path.join(bundlePath, 'template', 'config', 'garda.config.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'review-capabilities.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'paths.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'token-economy.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'output-filters.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'skill-packs.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'optional-skill-selection-policy.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'isolation-mode.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'profiles.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'runtime-retention.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'skills-index.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'skills-headlines.json'), '{}\n');
    writeStatusFixtureFile(path.join(bundlePath, 'live', 'config', 'garda.config.json'), '{}\n');

    const now = new Date();
    fs.utimesSync(path.join(tmpDir, 'bin', 'garda.js'), now, now);
    fs.utimesSync(path.join(bundlePath, 'bin', 'garda.js'), now, now);
}

test('resolveInitAnswersPath resolves relative path inside root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        const resolved = resolveInitAnswersPath(tmpDir, 'runtime/init-answers.json');
        assert.ok(resolved.includes('runtime'));
        assert.ok(resolved.includes('init-answers.json'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('resolveInitAnswersPath throws for path escaping root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        assert.throws(
            () => resolveInitAnswersPath(tmpDir, '../../etc/passwd'),
            /must resolve inside TargetRoot/
        );
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot does not read init answers from outside target root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    const outsidePath = path.join(os.tmpdir(), `status-outside-${Date.now()}.json`);
    try {
        fs.writeFileSync(outsidePath, JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Gemini',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'CLI_INTERACTIVE'
        }), 'utf8');

        const snapshot = getStatusSnapshot(tmpDir, outsidePath);
        assert.equal(snapshot.initAnswersPresent, false);
        assert.ok(snapshot.initAnswersError !== null);
        assert.match(snapshot.initAnswersError!, /must resolve inside TargetRoot/i);
        assert.notEqual(snapshot.initAnswersResolvedPath, outsidePath);
        assert.equal(snapshot.sourceOfTruth, null);
    } finally {
        try { fs.rmSync(outsidePath, { force: true }); } catch { /* best-effort */ }
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot returns not-installed state for empty directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.bundlePresent, false);
        assert.equal(snapshot.initAnswersPresent, false);
        assert.equal(snapshot.taskPresent, false);
        assert.equal(snapshot.livePresent, false);
        assert.equal(snapshot.usagePresent, false);
        assert.equal(snapshot.primaryInitializationComplete, false);
        assert.equal(snapshot.agentInitializationComplete, false);
        assert.equal(snapshot.readyForTasks, false);
        assert.ok(snapshot.recommendedNextCommand.includes('setup'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot detects bundle-present state', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundlePath, { recursive: true });

    try {
        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.bundlePresent, true);
        assert.equal(snapshot.initAnswersPresent, false);
        assert.ok(snapshot.recommendedNextCommand.includes('setup'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot reads init answers when present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const runtimePath = path.join(bundlePath, 'runtime');
    const livePath = path.join(bundlePath, 'live');
    fs.mkdirSync(runtimePath, { recursive: true });
    fs.mkdirSync(livePath, { recursive: true });
    fs.writeFileSync(
        path.join(runtimePath, 'init-answers.json'),
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
        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.bundlePresent, true);
        assert.equal(snapshot.initAnswersPresent, true);
        assert.equal(snapshot.initAnswersError, null);
        assert.equal(snapshot.assistantLanguage, 'English');
        assert.equal(snapshot.sourceOfTruth, 'Claude');
        assert.equal(snapshot.canonicalEntrypoint, 'CLAUDE.md');
        assert.equal(snapshot.collectedVia, 'CLI_INTERACTIVE');
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot prefers confirmed agent-init language while still exposing full-suite flag and latest update notice', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'Russian',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                OrdinaryDocPathsConfirmed: true,
                OrdinaryDocPaths: ['CHANGELOG.md'],
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        writeStatusFixtureFile(
            path.join(bundlePath, 'live', 'config', 'workflow-config.json'),
            JSON.stringify({
                compile_gate: {
                    command: TEST_COMPILE_GATE_COMMAND
                },
                full_suite_validation: {
                    enabled: true,
                    command: 'npm test'
                }
            }, null, 2)
        );
        writeStatusFixtureFile(
            path.join(bundlePath, 'runtime', 'update-reports', 'update-20260422-010000.md'),
            [
                '# Update Report',
                '',
                'UpdatedVersion: 1.2.3'
            ].join('\n')
        );

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.assistantLanguage, 'Russian');
        assert.equal(snapshot.assistantLanguageConfirmed, true);
        assert.equal(snapshot.mandatoryFullSuiteEnabled, true);
        assert.equal(snapshot.mandatoryFullSuiteCommand, 'npm test');
        assert.match(snapshot.mandatoryFullSuitePerformance || '', /mode=standard/);
        assert.equal(snapshot.latestUpdateNotice, '1.2.3');
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('buildAgentInitOutput renders compact report labels in English while preserving confirmed agent-init language', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'Russian',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                OrdinaryDocPathsConfirmed: true,
                OrdinaryDocPaths: ['CHANGELOG.md', 'docs/plan.md'],
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const output = buildAgentInitOutput({
            targetRoot: tmpDir,
            initAnswersPath: path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'),
            bundleRoot: path.join(tmpDir, 'garda-agent-orchestrator'),
            projectRulesUpdated: true,
            skillsPromptCompleted: true,
            verifyPassed: true,
            manifestPassed: true,
            compileGateCommand: 'python -m compileall .',
            compileGateCommandConfigured: true,
            ordinaryDocPaths: ['CHANGELOG.md', 'docs/plan.md'],
            ordinaryDocPathsDiscovered: ['CHANGELOG.md', 'docs/plan.md'],
            ordinaryDocPathsConfirmed: true,
            ordinaryDocPathsNeedsConfirmation: false,
            ordinaryDocPathsPersisted: true,
            ordinaryDocPathsConfigPath: path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'paths.json'),
            ordinaryDocPathsEditHint: 'Edit garda-agent-orchestrator/live/config/paths.json field ordinary_doc_paths.',
            projectMemoryInitialized: true,
            projectMemoryValidated: true,
            projectMemoryMode: 'check',
            projectMemoryDir: 'live/docs/project-memory',
            projectMemoryReadFirst: [
                'live/docs/project-memory/README.md',
                'live/docs/project-memory/compact.md'
            ],
            projectMemorySummaryRule: 'live/docs/agent-rules/15-project-memory.md',
            projectMemoryBootstrapReport: 'runtime/project-memory/bootstrap-report.json',
            projectMemoryWarnings: [],
            verifyResult: { passed: true },
            manifestResult: { passed: true },
            activeAgentFiles: ['AGENTS.md'],
            agentInitStatePath: path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'agent-init-state.json'),
            readyForTasks: false,
            state: {
                Version: 1,
                AssistantLanguage: 'Russian',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                OrdinaryDocPathsConfirmed: true,
                OrdinaryDocPaths: ['CHANGELOG.md', 'docs/plan.md'],
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ProjectMemoryInitialized: true,
                ProjectMemoryValidated: true,
                ProjectMemoryMode: 'check',
                ProjectMemoryDir: 'live/docs/project-memory',
                ProjectMemoryReadFirst: [
                    'live/docs/project-memory/README.md',
                    'live/docs/project-memory/compact.md'
                ],
                ProjectMemorySummaryRule: 'live/docs/agent-rules/15-project-memory.md',
                ProjectMemoryBootstrapReport: 'runtime/project-memory/bootstrap-report.json',
                ProjectMemoryWarnings: [],
                ActiveAgentFiles: ['AGENTS.md']
            }
        } as unknown as Parameters<typeof buildAgentInitOutput>[0]);

        assert.ok(output.includes('Agent-init summary'));
        assert.ok(output.includes('Language: Russian (normalized)'));
        assert.ok(output.includes('Next command: Next: resolve blockers and rerun agent-init ()'));
        assert.ok(output.includes('OrdinaryDocPaths: CHANGELOG.md, docs/plan.md'));
        assert.ok(output.includes('OrdinaryDocPathsNeedsConfirmation: False'));
        assert.ok(output.includes('OrdinaryDocPathsEdit: Edit garda-agent-orchestrator/live/config/paths.json field ordinary_doc_paths.'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot captures init answers error for invalid JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const runtimePath = path.join(bundlePath, 'runtime');
    fs.mkdirSync(runtimePath, { recursive: true });
    fs.writeFileSync(
        path.join(runtimePath, 'init-answers.json'),
        'not valid json',
        'utf8'
    );

    try {
        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.initAnswersPresent, true);
        assert.ok(snapshot.initAnswersError !== null);
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot keeps CLI-collected setup in agent handoff state even when commands are filled', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'CLI_INTERACTIVE');
        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.primaryInitializationComplete, true);
        assert.equal(snapshot.agentInitializationComplete, false);
        assert.equal(snapshot.readyForTasks, false);
        assert.equal(snapshot.agentInitializationPendingReason, 'AGENT_HANDOFF_REQUIRED');
        assert.ok(snapshot.recommendedNextCommand.includes('AGENT_INIT_PROMPT.md'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot marks workspace ready only after AGENT_INIT_PROMPT initialization with commands filled', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.primaryInitializationComplete, true);
        assert.equal(snapshot.agentInitializationComplete, true);
        assert.equal(snapshot.readyForTasks, true);
        assert.equal(snapshot.agentInitializationPendingReason, null);
        assert.equal(snapshot.recommendedNextCommand, 'Execute task <task-id> from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.');
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot blocks ready state when compile gate command remains unconfigured', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });
        writeStatusFixtureFile(
            path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            JSON.stringify({
                compile_gate: {
                    command: '__COMPILE_GATE_COMMAND_UNCONFIGURED__'
                }
            }, null, 2)
        );

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.agentInitializationPendingReason, 'PROJECT_COMMANDS_PENDING');
        assert.equal(snapshot.agentInitializationComplete, false);
        assert.equal(snapshot.readyForTasks, false);
        assert.deepEqual(snapshot.missingProjectCommands, ['compile_gate.command']);
        assert.ok(snapshot.recommendedNextCommand.includes('agent-init --target-root'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('buildAgentInitializationRecoveryGuidance quotes target roots with shell metacharacters', () => {
    const targetRoot = 'C:\\tmp\\project $(Invoke-Expression bad) `tick` \'single\' "double"';
    const guidance = buildAgentInitializationRecoveryGuidance({
        bundlePath: 'C:\\tmp\\project\\garda-agent-orchestrator',
        resolvedTargetRoot: targetRoot,
        agentInitializationPendingReason: 'PROJECT_COMMANDS_PENDING'
    });
    const quotedTargetRoot = quoteCommandValue(targetRoot);

    assert.ok(guidance.primary.includes(`agent-init --target-root ${quotedTargetRoot}`));
    assert.ok(guidance.alternatives.some((command) => command.includes(`--target-root ${quotedTargetRoot}`)));
    assert.ok(!guidance.primary.includes(`--target-root "${targetRoot}"`));
    assert.ok(!guidance.alternatives.some((command) => command.includes(`--target-root "${targetRoot}"`)));
});

test('getStatusSnapshot blocks ready state when workflow config is missing compile gate command source', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            workflowConfig: false,
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.agentInitializationPendingReason, 'PROJECT_COMMANDS_PENDING');
        assert.equal(snapshot.agentInitializationComplete, false);
        assert.equal(snapshot.readyForTasks, false);
        assert.deepEqual(snapshot.missingProjectCommands, ['compile_gate.command']);
        assert.ok(snapshot.recommendedNextCommand.includes('agent-init --target-root'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot recommends the first executable task from TASK.md active queue', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            taskMdContent: makeActiveQueueTaskMd([
                '| T-711 | 🟩 DONE | P2 | workflow | Done task | codex | 2026-06-05 | strict | done |',
                '| T-708 | 🟪 DECOMPOSED | P2 | refactor | Parent task | codex | 2026-06-05 | strict | use children |',
                '| T-721 | 🟥 BLOCKED | P0 | runtime | Blocked task | codex | 2026-06-05 | strict | blocked |',
                '| T-722 | 🟦 TODO | P0 | validators | Resolve status recommendation | codex | 2026-06-05 | strict | next |',
                '| T-723 | 🟦 TODO | P1 | release | Later task | codex | 2026-06-05 | strict | later |'
            ]),
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.readyForTasks, true);
        assert.equal(snapshot.recommendedNextCommand, 'Execute task T-722 from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.');
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot recommends an in-progress task before a later todo task', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            taskMdContent: makeActiveQueueTaskMd([
                '| T-722-F1 | 🟨 IN_PROGRESS | P2 | tests | Resume current recommendation test | codex | 2026-06-05 | balanced | first executable row |',
                '| T-723 | 🟦 TODO | P1 | release | Later task | codex | 2026-06-05 | strict | later TODO row |'
            ]),
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.readyForTasks, true);
        assert.equal(snapshot.recommendedNextCommand, 'Execute task T-722-F1 from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.');
        assert.ok(!snapshot.recommendedNextCommand.includes('T-723'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot ignores T-001 outside the active queue ID column', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            taskMdContent: makeActiveQueueTaskMd([
                '| T-722 | 🟦 TODO | P0 | validators | Do not pick T-001 from title | codex | 2026-06-05 | strict | T-001 appears only in notes |',
                '| T-723 | 🟦 TODO | P1 | release | Later task | codex | 2026-06-05 | strict | later |'
            ]),
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.readyForTasks, true);
        assert.equal(snapshot.recommendedNextCommand, 'Execute task T-722 from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.');
        assert.ok(!snapshot.recommendedNextCommand.includes('T-001'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot does not default to T-001 when active queue has no executable tasks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            taskMdContent: makeActiveQueueTaskMd([
                '| T-711 | 🟩 DONE | P2 | workflow | Done task | codex | 2026-06-05 | strict | done |',
                '| T-708 | 🟪 DECOMPOSED | P2 | refactor | Parent task | codex | 2026-06-05 | strict | use children |',
                '| T-721 | 🟥 BLOCKED | P0 | runtime | Blocked task | codex | 2026-06-05 | strict | blocked |'
            ]),
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.readyForTasks, true);
        assert.equal(snapshot.recommendedNextCommand, 'No executable tasks found in TASK.md Active Queue; add or reopen a task before starting task execution.');
        assert.ok(!snapshot.recommendedNextCommand.includes('T-001'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot does not default to T-001 when active queue table is empty', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            taskMdContent: makeActiveQueueTaskMd([]),
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.readyForTasks, true);
        assert.equal(snapshot.recommendedNextCommand, 'No executable tasks found in TASK.md Active Queue; add or reopen a task before starting task execution.');
        assert.ok(!snapshot.recommendedNextCommand.includes('T-001'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot blocks ready while ordinary document paths are unconfirmed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                OrdinaryDocPathsConfirmed: false,
                OrdinaryDocPaths: [],
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.agentInitializationPendingReason, 'ORDINARY_DOC_PATHS_PENDING');
        assert.equal(snapshot.agentInitializationComplete, false);
        assert.equal(snapshot.readyForTasks, false);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('Confirm ordinary document paths'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot blocks ready while optional specialist skills prompt is incomplete', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: false,
                OrdinaryDocPathsConfirmed: true,
                OrdinaryDocPaths: ['CHANGELOG.md'],
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.agentInitializationPendingReason, 'SKILLS_PROMPT_PENDING');
        assert.equal(snapshot.agentInitializationComplete, false);
        assert.equal(snapshot.readyForTasks, false);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('optional specialist-skills yes/no question'));
        assert.ok(output.includes('user decline is allowed'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot blocks ready while project memory is not initialized', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md'],
                ProjectMemoryInitialized: false,
                ProjectMemoryValidated: true
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.agentInitializationPendingReason, 'PROJECT_MEMORY_PENDING');
        assert.equal(snapshot.agentInitializationComplete, false);
        assert.equal(snapshot.readyForTasks, false);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('Initialize or refresh Garda project memory'));
        assert.ok(output.includes('ProjectMemoryInitRefreshPrompt: Initialize or refresh Garda project memory.'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot lists incomplete agent-init checkpoints even when verify passed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: false,
                ProjectRulesUpdated: false,
                SkillsPromptCompleted: false,
                OrdinaryDocPathsConfirmed: false,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md'],
                ProjectMemoryInitialized: false,
                ProjectMemoryValidated: false
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.agentInitializationPendingReason, 'ACTIVE_AGENT_FILES_PENDING');
        assert.deepEqual(snapshot.agentInitializationPendingReasons, [
            'ACTIVE_AGENT_FILES_PENDING',
            'PROJECT_RULES_PENDING',
            'SKILLS_PROMPT_PENDING',
            'ORDINARY_DOC_PATHS_PENDING',
            'PROJECT_MEMORY_PENDING'
        ]);
        assert.equal(snapshot.agentInitializationComplete, false);
        assert.equal(snapshot.readyForTasks, false);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('Agent setup required'));
        assert.ok(output.includes('AgentInitPendingCheckpoints: 5'));
        assert.ok(output.includes('VerifyCheckpoint: PASS'));
        assert.ok(output.includes('ManifestValidationCheckpoint: PASS'));
        assert.ok(output.includes('Active agent files: confirm active provider entrypoint files'));
        assert.ok(output.includes('Project rules: update or accept project-specific live rules'));
        assert.ok(output.includes('Specialist skills: ask the optional specialist-skills question'));
        assert.ok(output.includes('Ordinary docs: confirm ordinary document paths'));
        assert.ok(output.includes('Project memory: run agent-init to refresh project-memory checkpoints'));
        assert.ok(output.includes('ProjectMemoryInitRefreshPrompt: Initialize or refresh Garda project memory.'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot keeps validation failure distinct from passed verify with incomplete setup', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                OrdinaryDocPathsConfirmed: true,
                VerificationPassed: false,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md'],
                ProjectMemoryInitialized: true,
                ProjectMemoryValidated: true
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.agentInitializationPendingReason, 'VALIDATION_PENDING');
        assert.deepEqual(snapshot.agentInitializationPendingReasons, ['VALIDATION_PENDING']);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('AgentInitPendingCheckpoints: 1'));
        assert.ok(output.includes('VerifyCheckpoint: FAIL'));
        assert.ok(output.includes('ManifestValidationCheckpoint: PASS'));
        assert.ok(output.includes('Validation: rerun agent-init validation until verify and manifest validation both pass.'));
        assert.ok(!output.includes('Project memory: run agent-init to refresh project-memory checkpoints'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot keeps malformed agent-init state distinct from project-memory pending', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md'],
                ProjectMemoryInitialized: false,
                ProjectMemoryValidated: false
            }
        });
        fs.writeFileSync(
            path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'agent-init-state.json'),
            '{"ProjectMemoryInitialized":',
            'utf8'
        );

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.agentInitializationPendingReason, 'AGENT_STATE_INVALID');
        assert.equal(snapshot.agentInitializationComplete, false);
        assert.equal(snapshot.readyForTasks, false);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('AgentInitStateStatus: INVALID'));
        assert.ok(!output.includes('ProjectMemoryInitRefreshPrompt:'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot blocks ready while project memory is not validated', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md'],
                ProjectMemoryInitialized: true,
                ProjectMemoryValidated: false
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.agentInitializationPendingReason, 'PROJECT_MEMORY_PENDING');
        assert.equal(snapshot.agentInitializationComplete, false);
        assert.equal(snapshot.readyForTasks, false);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('Initialize or refresh Garda project memory'));
        assert.ok(output.includes('ProjectMemoryInitRefreshPrompt: Initialize or refresh Garda project memory.'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot omits project-memory init prompt after memory is validated', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                OrdinaryDocPathsConfirmed: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md'],
                ProjectMemoryInitialized: true,
                ProjectMemoryValidated: true
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.agentInitializationPendingReason, null);
        assert.equal(snapshot.agentInitializationComplete, true);
        assert.equal(snapshot.readyForTasks, true);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(!output.includes('ProjectMemoryInitRefreshPrompt:'));
        assert.ok(!output.includes('Initialize or refresh Garda project memory'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot recommends profile depth in next command when profile is configured', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        writeProfilesConfig(bundlePath, { active_profile: 'fast', depth: 3 });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.recommendedNextCommand, 'Execute task <task-id> from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.');
        assert.equal(snapshot.reviewRemediationModePolicy?.legacyFullOnly, true);
        assert.match(formatStatusSnapshot(snapshot), /ReviewRemediationModePolicy: configured=false, mode=FULL-only/u);
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('status exposes explicit FULL/DELTA profile policy readiness', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-status-remediation-mode-'));
    try {
        seedInitializedWorkspace(tmpDir, 'INTERACTIVE', {
            agentInitState: {
                AssistantLanguage: 'English',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        writeProfilesConfig(bundlePath, {
            active_profile: 'balanced',
            depth: 2,
            review_remediation_mode_policy: {
                schema_version: 2,
                policy_id: 'conservative_review_remediation_mode_v1',
                initial_review_mode: 'FULL',
                delta_eligible_review_types: ['code', 'refactor', 'test'],
                force_full_categories: ['ambiguous', 'generated_churn', 'global'],
                max_delta_changed_files: 4,
                max_delta_changed_lines: 240,
                max_consecutive_delta_reviews: 3
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.reviewRemediationModePolicy?.legacyFullOnly, false);
        assert.deepEqual(snapshot.reviewRemediationModePolicy?.deltaEligibleReviewTypes, ['code', 'refactor', 'test']);
        assert.match(formatStatusSnapshot(snapshot), /mode=FULL\/DELTA/u);
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot flags stale agent-init state when active agent files no longer match answers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            activeAgentFiles: 'AGENTS.md, CLAUDE.md',
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });
        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.readyForTasks, false);
        assert.equal(snapshot.agentInitializationPendingReason, 'AGENT_STATE_STALE');
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot summarizes toxin metrics without creating metrics.jsonl', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-toxin-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        const metricsPath = path.join(bundlePath, 'runtime', 'metrics.jsonl');
        writeStatusFixtureFile(path.join(bundlePath, 'runtime', 'reviews', 'oversized-review.json'), 'x'.repeat(600 * 1024));

        const snapshot = getStatusSnapshot(tmpDir);

        assert.ok(snapshot.toxinMetricsSummary !== null);
        assert.equal(snapshot.toxinMetricsSummary!.noisy_artifact_count, 1);
        assert.ok(snapshot.toxinMetricsSummary!.runtime_total_bytes > 0);
        assert.equal(fs.existsSync(metricsPath), false);
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getTaskCycleStatusSnapshot preserves routing fields and skips toxin traversal on cold and warm reads', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cycle-status-'));
    const fsModule = require('node:fs') as typeof import('node:fs');
    const originalReaddirSync = fsModule.readdirSync;
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            taskMdContent: makeActiveQueueTaskMd([
                '| T-001 | 🟨 IN_PROGRESS | P1 | runtime | Current task | codex | 2026-08-02 | balanced | partial lifecycle |',
                '| T-OTHER | 🟨 IN_PROGRESS | P2 | runtime | Other task | codex | 2026-08-02 | balanced | partial lifecycle |'
            ]),
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        const eventsRoot = path.join(bundlePath, 'runtime', 'task-events');
        writeIntegrityTaskModeEvent(path.join(eventsRoot, 'T-001.jsonl'), 'T-001');
        writeIntegrityTaskModeEvent(path.join(eventsRoot, 'T-OTHER.jsonl'), 'T-OTHER');
        const toxinRoot = path.join(bundlePath, 'runtime', 'backups');
        for (let index = 0; index < 20; index++) {
            writeStatusFixtureFile(path.join(toxinRoot, `batch-${index}`, 'artifact.json'), '{}\n');
        }

        let narrowTraversalCount = 0;
        let fullTraversalCount = 0;
        let phase: 'narrow' | 'full' = 'narrow';
        fsModule.readdirSync = ((targetPath: fs.PathLike, options?: unknown) => {
            const resolvedPath = path.resolve(String(targetPath));
            if (resolvedPath === path.resolve(toxinRoot) || resolvedPath.startsWith(`${path.resolve(toxinRoot)}${path.sep}`)) {
                if (phase === 'narrow') narrowTraversalCount++;
                else fullTraversalCount++;
            }
            return originalReaddirSync(targetPath, options as never);
        }) as typeof fsModule.readdirSync;

        const cold = getTaskCycleStatusSnapshot(tmpDir, 'T-001');
        const warm = getTaskCycleStatusSnapshot(tmpDir, 'T-001');
        phase = 'full';
        const full = getStatusSnapshot(tmpDir);

        assert.equal(narrowTraversalCount, 0);
        assert.ok(fullTraversalCount > 0, 'control snapshot should traverse the seeded toxin root');
        assert.deepEqual(warm, cold);
        assert.equal(cold.readyForTasks, full.readyForTasks);
        assert.equal(cold.enforceNoAutoCommit, full.enforceNoAutoCommit);
        assert.equal(cold.assistantLanguage, full.assistantLanguage);
        assert.equal(cold.assistantLanguageConfirmed, full.assistantLanguageConfirmed);
        assert.equal(cold.recommendedNextCommand, full.recommendedNextCommand);
        assert.equal(cold.latestUpdateNotice, full.latestUpdateNotice);
        assert.deepEqual(cold.timelineWarningDetails.map((detail) => detail.task_id), ['T-001']);
        assert.deepEqual(
            full.timelineWarningDetails?.map((detail) => detail.task_id).sort(),
            ['T-001', 'T-OTHER']
        );
    } finally {
        fsModule.readdirSync = originalReaddirSync;
        cleanupStatusTempDir(tmpDir);
    }
});

test('getTaskCycleStatusSnapshot does not authorize historical handshake artifacts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cycle-status-'));
    const fsModule = require('node:fs');
    const originalLstatSync = fsModule.lstatSync;
    const originalRealpathSync = fsModule.realpathSync;
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            taskMdContent: makeActiveQueueTaskMd([
                '| T-ACTIVE | 🟨 IN_PROGRESS | P1 | runtime | Current task | codex | 2026-08-02 | balanced | partial lifecycle |'
            ]),
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        writeStatusFixtureFile(path.join(reviewsDir, 'T-HISTORICAL-handshake.json'), JSON.stringify({
            status: 'FAILED',
            provider: 'Codex',
            violations: ['Historical failure.']
        }));
        writeStatusFixtureFile(path.join(reviewsDir, 'T-ACTIVE-handshake.json'), JSON.stringify({
            status: 'FAILED',
            provider: 'Codex',
            violations: ['Active failure.']
        }));

        let historicalAuthorizationCount = 0;
        const isHistoricalReviewArtifact = (candidate: fs.PathLike): boolean => (
            path.dirname(path.resolve(String(candidate))) === path.resolve(reviewsDir)
            && path.basename(String(candidate)).startsWith('T-HISTORICAL-')
        );
        fsModule.lstatSync = ((candidate: fs.PathLike, options?: unknown) => {
            if (isHistoricalReviewArtifact(candidate)) historicalAuthorizationCount += 1;
            return originalLstatSync(candidate, options as never);
        }) as typeof fsModule.lstatSync;
        fsModule.realpathSync = ((candidate: fs.PathLike, options?: unknown) => {
            if (isHistoricalReviewArtifact(candidate)) historicalAuthorizationCount += 1;
            return originalRealpathSync(candidate, options as never);
        }) as typeof fsModule.realpathSync;

        const snapshot = getTaskCycleStatusSnapshot(tmpDir, 'T-ACTIVE');
        assert.equal(snapshot.readyForTasks, true, 'Task-cycle status keeps handshake failures informational');
        assert.equal(historicalAuthorizationCount, 0);
    } finally {
        fsModule.lstatSync = originalLstatSync;
        fsModule.realpathSync = originalRealpathSync;
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot reads toxin metrics from the resolved legacy bundle runtime', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-legacy-toxin-'));
    try {
        const legacyBundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        seedBundleIdentity(legacyBundlePath, 'garda-agent-orchestrator', path.join('bin', 'garda.js'));
        writeStatusFixtureFile(path.join(legacyBundlePath, 'live', 'USAGE.md'), '# Usage\n');
        writeStatusFixtureFile(path.join(legacyBundlePath, 'runtime', 'reviews', 'oversized-review.json'), 'x'.repeat(600 * 1024));
        writeStatusFixtureFile(
            path.join(legacyBundlePath, 'runtime', 'metrics.jsonl'),
            Array.from({ length: 11 }, (_, index) => JSON.stringify({ index })).join('\n') + '\n'
        );
        writeStatusFixtureFile(
            path.join(tmpDir, 'runtime', 'metrics.jsonl'),
            Array.from({ length: 3 }, (_, index) => JSON.stringify({ root_index: index })).join('\n') + '\n'
        );

        const snapshot = getStatusSnapshot(tmpDir);

        assert.equal(snapshot.bundlePath, legacyBundlePath);
        assert.ok(snapshot.toxinMetricsSummary !== null);
        assert.equal(snapshot.toxinMetricsSummary!.noisy_artifact_count, 1);
        assert.equal(snapshot.toxinMetricsSummary!.metrics_file_lines, 11);
        assert.ok(snapshot.toxinMetricsSummary!.runtime_total_bytes > 0);
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('formatStatusSnapshot produces expected text markers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        const snapshot = getStatusSnapshot(tmpDir);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('GARDA_STATUS'));
        assert.ok(output.includes('Not installed'));
        assert.ok(output.includes('Workspace Stages'));
        assert.ok(output.includes('Installed'));
        assert.equal(snapshot.recommendedUiCommand, 'garda ui --actions');
        assert.ok(output.includes('RecommendedUiCommand: garda ui --actions'));
        assert.ok(output.includes('RecommendedNextCommand'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('formatStatusSnapshot prints mandatory full-suite performance guidance when configured', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENTS.md');
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        writeStatusFixtureFile(
            path.join(bundlePath, 'live', 'config', 'workflow-config.json'),
            JSON.stringify({
                compile_gate: {
                    command: TEST_COMPILE_GATE_COMMAND
                },
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:sharded'
                }
            }, null, 2)
        );
        const snapshot = getStatusSnapshot(tmpDir);
        const output = formatStatusSnapshot(snapshot);

        assert.ok(output.includes('MandatoryFullSuite: enabled'));
        assert.ok(output.includes('MandatoryFullSuiteCommand: npm run test:sharded'));
        assert.ok(output.includes('MandatoryFullSuitePerformance: mode=optimized_sharded; optimized=true; boundary=mandatory_full_suite_not_smoke_or_fast; optimized_command="npm run test:sharded"; fallback_command="npm test"'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('formatStatusSnapshot surfaces scope budget WARN state from latest preflight', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENTS.md');
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        writeScopeBudgetPreflight(bundlePath, 'T-100', 2500);

        const snapshot = getStatusSnapshot(tmpDir);
        const output = formatStatusSnapshot(snapshot);

        assert.equal(snapshot.scopeBudgetGuardStatus?.status, 'WARN');
        assert.equal(snapshot.scopeBudgetGuardStatus?.continuation_allowed, true);
        assert.ok(output.includes('ScopeBudgetGuardStatus: WARN'));
        assert.ok(output.includes('ScopeBudgetGuardSummary: Scope budget guard: WARN'));
        assert.ok(output.includes('ScopeBudgetGuardContinuationAllowed: yes'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('formatStatusSnapshot uses companion effective scope budget metrics', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENTS.md');
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        writeScopeBudgetPreflight(bundlePath, 'T-100', 1000, {
            changedFilesCount: 56,
            effectiveChangedFilesCount: 35,
            uiI18nCompanionScope: true
        });

        const snapshot = getStatusSnapshot(tmpDir);
        const output = formatStatusSnapshot(snapshot);

        assert.equal(snapshot.scopeBudgetGuardStatus?.changed_files_count, 35);
        assert.equal(snapshot.scopeBudgetGuardStatus?.status, 'WARN');
        assert.equal(snapshot.scopeBudgetGuardStatus?.continuation_allowed, true);
        assert.ok(output.includes('ScopeBudgetGuardSummary: Scope budget guard: WARN (changed_files_count=35>20 WARN)'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('formatStatusSnapshot binds scope budget status to current task preflight before historical artifacts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENTS.md', {
            taskMdContent: makeActiveQueueTaskMd([
                '| T-100 | 🟨 IN_PROGRESS | P2 | workflow | Current task | gpt-5.5 | 2026-07-01 | strict | Current |',
                '| T-999 | 🟦 TODO | P2 | workflow | Later task | gpt-5.5 | 2026-07-01 | strict | Later |'
            ])
        });
        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        writeScopeBudgetPreflight(bundlePath, 'T-100', 1000);
        writeScopeBudgetPreflight(bundlePath, 'T-999', 6000, { changedFilesCount: 100 });
        const recent = new Date('2026-07-01T12:00:00.000Z');
        fs.utimesSync(path.join(bundlePath, 'runtime', 'reviews', 'T-999-preflight.json'), recent, recent);

        const snapshot = getStatusSnapshot(tmpDir);

        assert.equal(snapshot.scopeBudgetGuardStatus?.status, 'OK');
        assert.match(snapshot.scopeBudgetGuardStatus?.preflight_path || '', /T-100-preflight\.json$/u);
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('formatStatusSnapshot includes explicit next stage for CLI-collected setup', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'CLI_NONINTERACTIVE');
        const snapshot = getStatusSnapshot(tmpDir);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('Agent setup required'));
        assert.ok(output.includes('Next stage: Launch your agent with AGENT_INIT_PROMPT.md'));
        assert.ok(output.includes('RecommendedUiCommand: garda ui --actions'));
        assert.ok(output.includes('RecommendedNextCommand: Give your agent'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('formatStatusSnapshot accepts custom heading', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        const snapshot = getStatusSnapshot(tmpDir);
        const output = formatStatusSnapshot(snapshot, { heading: 'CUSTOM_HEADING' });
        assert.ok(output.includes('CUSTOM_HEADING'));
        assert.ok(!output.includes('GARDA_STATUS'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot warns about incomplete task timelines', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            taskMdContent: makeActiveQueueTaskMd([
                '| T-001 | 🟨 IN_PROGRESS | P1 | runtime | Active incomplete timeline | codex | 2026-03-28 | balanced | partial lifecycle |'
            ]),
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        const timelinePath = path.join(bundlePath, 'runtime', 'task-events', 'T-001.jsonl');
        const taskModeEvent: Record<string, unknown> = {
            timestamp_utc: '2026-03-28T10:00:00.000Z',
            task_id: 'T-001',
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            actor: 'gate',
            message: 'Task mode entered.',
            details: {},
            integrity: {
                schema_version: 1,
                task_sequence: 1,
                prev_event_sha256: null,
                event_sha256: ''
            }
        };
        (taskModeEvent.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(taskModeEvent);
        writeStatusFixtureFile(timelinePath, JSON.stringify(taskModeEvent) + '\n');

        const snapshot = getStatusSnapshot(tmpDir);
        const output = formatStatusSnapshot(snapshot);
        assert.equal(snapshot.readyForTasks, true);
        assert.equal(snapshot.timelineTaskCount, 1);
        assert.equal(snapshot.timelineHealthy, 0);
        assert.equal(snapshot.timelineWarningDetails?.length, 1);
        assert.equal(snapshot.timelineWarningDetails?.[0]?.kind, 'INCOMPLETE');
        assert.ok(snapshot.timelineWarnings.some((warning) => warning.includes('INCOMPLETE timeline: T-001.jsonl')));
        assert.ok(snapshot.timelineWarnings.some((warning) => warning.includes('Repair: resume T-001 with node bin/garda.js next-step "T-001" --repo-root "."')));
        assert.ok(snapshot.timelineWarnings.some((warning) => warning.includes('task-cycle diagnostic; workspace readiness is evaluated separately')));
        assert.ok(output.includes('TaskTimelines: 0/1 complete'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('formatStatusSnapshot shows invalid timeline warnings even when no canonical timelines exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        const eventsRoot = path.join(bundlePath, 'runtime', 'task-events');
        writeStatusFixtureFile(path.join(eventsRoot, '--help.jsonl'), 'not a canonical timeline\n');

        const snapshot = getStatusSnapshot(tmpDir);
        const output = formatStatusSnapshot(snapshot);
        assert.equal(snapshot.timelineTaskCount, 0);
        assert.ok(snapshot.timelineWarnings.some((warning) => warning.includes('INVALID timeline file: --help.jsonl')));
        assert.ok(output.includes('TaskTimelines: 0/0 complete'));
        assert.ok(output.includes('Warning: INVALID timeline file: --help.jsonl'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot distinguishes active blocked incomplete timelines from abandoned incomplete timelines', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            taskMdContent: makeActiveQueueTaskMd([
                '| T-020 | 🟥 BLOCKED | P1 | runtime | Active blocker | codex | 2026-06-05 | strict | blocked_reason_code=EXTERNAL |',
                '| T-CLI-ART | 🟥 BLOCKED | P1 | runtime | Alphanumeric blocker | codex | 2026-06-05 | strict | blocked_reason_code=EXTERNAL |',
                '| T-021 | 🟨 IN_PROGRESS | P1 | runtime | Abandoned partial | codex | 2026-06-05 | strict | partial lifecycle |'
            ]),
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        const eventsRoot = path.join(bundlePath, 'runtime', 'task-events');
        writeIntegrityTaskModeEvent(path.join(eventsRoot, 'T-020.jsonl'), 'T-020');
        writeIntegrityTaskModeEvent(path.join(eventsRoot, 'T-CLI-ART.jsonl'), 'T-CLI-ART');
        writeIntegrityTaskModeEvent(path.join(eventsRoot, 'T-021.jsonl'), 'T-021');

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.timelineTaskCount, 3);
        assert.equal(snapshot.timelineHealthy, 0);
        assert.ok(snapshot.timelineWarnings.some((warning) =>
            warning.includes('INCOMPLETE timeline: T-020.jsonl')
            && warning.includes('Repair: resolve the active BLOCKED task state for T-020 in TASK.md')
        ));
        assert.ok(snapshot.timelineWarnings.some((warning) =>
            warning.includes('INCOMPLETE timeline: T-CLI-ART.jsonl')
            && warning.includes('Repair: resolve the active BLOCKED task state for T-CLI-ART in TASK.md')
        ));
        assert.ok(snapshot.timelineWarnings.some((warning) =>
            warning.includes('INCOMPLETE timeline: T-021.jsonl')
            && warning.includes('Repair: resume T-021 with node bin/garda.js next-step "T-021" --repo-root "."')
        ));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot classifies invalid legacy and integrity-failed task timelines with repair guidance', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        const eventsRoot = path.join(bundlePath, 'runtime', 'task-events');
        writeStatusFixtureFile(path.join(eventsRoot, 'T-010.jsonl'), '{ not json }\n');
        writeStatusFixtureFile(path.join(eventsRoot, 'T-011.jsonl'), JSON.stringify({
            timestamp_utc: '2026-03-28T10:00:00.000Z',
            task_id: 'T-011',
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            actor: 'gate',
            message: 'Legacy task mode entered.',
            details: {}
        }) + '\n');
        writeStatusFixtureFile(path.join(eventsRoot, 'T-012.jsonl'), JSON.stringify({
            timestamp_utc: '2026-03-28T10:00:00.000Z',
            task_id: 'T-012',
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            actor: 'gate',
            message: 'Task mode entered.',
            details: {},
            integrity: {
                schema_version: 1,
                task_sequence: 1,
                prev_event_sha256: null,
                event_sha256: '0'.repeat(64)
            }
        }) + '\n');

        const snapshot = getStatusSnapshot(tmpDir);
        assert.equal(snapshot.timelineTaskCount, 3);
        assert.equal(snapshot.timelineHealthy, 0);
        assert.ok(snapshot.timelineWarnings.some((warning) => warning.includes('INVALID timeline: T-010.jsonl')));
        assert.ok(snapshot.timelineWarnings.some((warning) => warning.includes('LEGACY timeline: T-011.jsonl')));
        assert.ok(snapshot.timelineWarnings.some((warning) => warning.includes('INTEGRITY_FAILED timeline: T-012.jsonl')));
        assert.equal(snapshot.timelineWarnings.filter((warning) => warning.includes('Repair:')).length, 3);
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot reports compliance drift when entrypoint lacks router reference', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });
        // Overwrite AGENTS.md with non-compliant content (no router reference)
        writeStatusFixtureFile(
            path.join(tmpDir, 'AGENTS.md'),
            [MANAGED_START, '# AGENTS.md', 'No router reference.', MANAGED_END].join('\n')
        );
        const snapshot = getStatusSnapshot(tmpDir);
        assert.ok(snapshot.providerComplianceResult !== null);
        assert.equal(snapshot.providerComplianceResult!.passed, false);
        assert.equal(snapshot.readyForTasks, false);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('Provider control compliance'));
        assert.ok(output.includes('Drift'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('formatStatusSnapshot includes compliance pass badge when compliant', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });
        const snapshot = getStatusSnapshot(tmpDir);
        assert.ok(snapshot.providerComplianceResult !== null);
        assert.equal(snapshot.providerComplianceResult!.passed, true);
        assert.equal(snapshot.readyForTasks, true);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('[x] Provider control compliance'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot surfaces protected-manifest MATCH when trusted manifest exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pm-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        // Build and write a matching trusted manifest from the current workspace state
        writeProtectedControlPlaneManifest(tmpDir);

        const snapshot = getStatusSnapshot(tmpDir);
        assert.ok(snapshot.protectedManifestEvidence !== null);
        assert.equal(snapshot.protectedManifestEvidence!.status, 'MATCH');
        assert.equal(snapshot.readyForTasks, true);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('Protected manifest (MATCH)'));
        assert.ok(output.includes('[x] Protected manifest'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot surfaces protected-manifest MISSING when no trusted manifest', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pm-missing-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const snapshot = getStatusSnapshot(tmpDir);
        assert.ok(snapshot.protectedManifestEvidence !== null);
        assert.equal(snapshot.protectedManifestEvidence!.status, 'MISSING');
        // MISSING is tolerated — workspace stays ready
        assert.equal(snapshot.readyForTasks, true);
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('Protected manifest (MISSING)'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot surfaces protected-manifest DRIFT and blocks readyForTasks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pm-drift-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');

        // Create a protected file and a manifest referencing a stale hash
        const protectedDir = path.join(bundlePath, 'dist');
        fs.mkdirSync(protectedDir, { recursive: true });
        fs.writeFileSync(path.join(protectedDir, 'index.js'), 'console.log("hello");', 'utf8');

        fs.writeFileSync(
            path.join(bundlePath, 'runtime', 'protected-control-plane-manifest.json'),
            JSON.stringify({
                schema_version: 1,
                event_source: 'refresh-protected-control-plane-manifest',
                timestamp_utc: new Date().toISOString(),
                workspace_root: tmpDir.replace(/\\/g, '/'),
                orchestrator_root: bundlePath.replace(/\\/g, '/'),
                protected_roots: ['garda-agent-orchestrator/dist'],
                protected_snapshot: {
                    'garda-agent-orchestrator/dist/index.js': 'stale-hash-does-not-match'
                },
                is_source_checkout: false
            }, null, 2),
            'utf8'
        );

        const snapshot = getStatusSnapshot(tmpDir);
        assert.ok(snapshot.protectedManifestEvidence !== null);
        assert.equal(snapshot.protectedManifestEvidence!.status, 'DRIFT');
        assert.ok(snapshot.protectedManifestEvidence!.changed_files.length > 0);
        assert.equal(snapshot.readyForTasks, false);
        assert.ok(snapshot.recommendedNextCommand.includes('garda-agent-orchestrator update'));
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('Protected manifest (DRIFT)'));
        assert.ok(output.includes('[ ] Protected manifest'));
        assert.ok(output.includes('Drift:'));
        assert.ok(output.includes('Fix: Run setup/update/reinit'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot treats source-checkout protected-manifest DRIFT as informational', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pm-source-drift-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });
        seedMatchingSourceCheckoutParity(tmpDir);
        writeProtectedControlPlaneManifest(tmpDir);

        writeStatusFixtureFile(
            path.join(tmpDir, 'src', 'cli', 'status-helper.ts'),
            'export const changed = true;\n'
        );
        writeStatusFixtureFile(
            path.join(tmpDir, 'dist', 'src', 'index.js'),
            'module.exports = { changed: true };\n'
        );

        const snapshot = getStatusSnapshot(tmpDir);
        assert.ok(snapshot.protectedManifestEvidence !== null);
        assert.equal(snapshot.protectedManifestEvidence!.status, 'DRIFT');
        assert.ok(snapshot.protectedManifestAssessment !== null);
        assert.equal(snapshot.protectedManifestAssessment!.code, 'INFO_SOURCE_CHECKOUT');
        assert.equal(snapshot.parityResult.isSourceCheckout, true);
        assert.equal(snapshot.parityResult.isStale, false);
        assert.equal(snapshot.readyForTasks, true);
        assert.ok(!snapshot.recommendedNextCommand.includes('garda-agent-orchestrator update'));

        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('Protected manifest (DRIFT)'));
        assert.ok(output.includes('[~] Protected manifest'));
        assert.ok(output.includes('Assessment: INFO_SOURCE_CHECKOUT'));
        assert.ok(output.includes('workspace ready') || output.includes('Workspace ready'));

        const inheritedDriftOutput = formatStatusSnapshot({
            ...snapshot,
            protectedManifestAssessment: {
                code: 'INFO_SOURCE_CHECKOUT_INHERITED_DRIFT',
                severity: 'warn',
                blocks: false,
                requires_refresh: true
            }
        });
        assert.ok(inheritedDriftOutput.includes('Assessment: INFO_SOURCE_CHECKOUT_INHERITED_DRIFT'));
        assert.ok(inheritedDriftOutput.includes('inherited from prior committed control-plane work'));
        assert.ok(inheritedDriftOutput.includes('should not force --orchestrator-work solely for this inherited clean-worktree drift'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

test('getStatusSnapshot surfaces protected-manifest INVALID and blocks readyForTasks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-pm-invalid-'));
    try {
        seedInitializedWorkspace(tmpDir, 'AGENT_INIT_PROMPT.md', {
            agentInitState: {
                Version: 1,
                AssistantLanguage: 'English',
                SourceOfTruth: 'Codex',
                AssistantLanguageConfirmed: true,
                ActiveAgentFilesConfirmed: true,
                ProjectRulesUpdated: true,
                SkillsPromptCompleted: true,
                VerificationPassed: true,
                ManifestValidationPassed: true,
                ActiveAgentFiles: ['AGENTS.md']
            }
        });

        const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.writeFileSync(
            path.join(bundlePath, 'runtime', 'protected-control-plane-manifest.json'),
            '{ invalid json',
            'utf8'
        );

        const snapshot = getStatusSnapshot(tmpDir);
        assert.ok(snapshot.protectedManifestEvidence !== null);
        assert.equal(snapshot.protectedManifestEvidence!.status, 'INVALID');
        assert.equal(snapshot.readyForTasks, false);
        assert.ok(snapshot.recommendedNextCommand.includes('garda-agent-orchestrator update'));
        const output = formatStatusSnapshot(snapshot);
        assert.ok(output.includes('Protected manifest (INVALID)'));
        assert.ok(output.includes('[ ] Protected manifest'));
        assert.ok(output.includes('malformed'));
        assert.ok(output.includes('Fix: Run setup/update/reinit'));
    } finally {
        cleanupStatusTempDir(tmpDir);
    }
});

/* ------------------------------------------------------------------ */
/*  formatStatusSnapshotCompact (T-019)                               */
/* ------------------------------------------------------------------ */

test('formatStatusSnapshotCompact emits single line when ready', () => {
    const snapshot = {
        targetRoot: '/tmp/test',
        bundlePath: '/tmp/test/garda-agent-orchestrator',
        initAnswersResolvedPath: '/tmp/test/init-answers.json',
        collectedVia: 'setup',
        activeAgentFiles: 'AGENTS.md',
        sourceOfTruth: 'Claude',
        canonicalEntrypoint: 'CLAUDE.md',
        bundlePresent: true,
        primaryInitializationComplete: true,
        agentInitializationComplete: true,
        readyForTasks: true,
        agentInitializationPendingReason: null as null,
        missingProjectCommands: [] as string[],
        initAnswersError: null as null,
        liveVersionError: null as null,
        agentInitStateError: null as null,
        commandsRulePath: '/tmp/test/commands.md',
        recommendedNextCommand: 'Execute task T-001',
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [] as string[],
            remediation: null as null
        },
        timelineTaskCount: 0,
        timelineHealthy: 0,
        timelineWarnings: [] as string[],
        providerComplianceResult: null as null,
        protectedManifestEvidence: null as null,
        initAnswersPathForDisplay: '/tmp/test/init-answers.json',
        initAnswersPresent: true,
        taskPresent: true,
        livePresent: true,
        usagePresent: true,
        agentInitStatePath: '/tmp/test/state.json',
        agentInitState: null as null
    };
    const output = formatStatusSnapshotCompact(snapshot as any);
    assert.ok(!output.includes('\n'), 'Compact ready output must be a single line');
    assert.ok(output.includes('GARDA_STATUS'));
    assert.ok(output.includes('ready'));
    assert.ok(output.includes('source=Claude'));
});

test('formatStatusSnapshotCompact emits full output when not ready', () => {
    const snapshot = {
        targetRoot: '/tmp/test',
        bundlePath: '/tmp/test/garda-agent-orchestrator',
        initAnswersResolvedPath: '/tmp/test/init-answers.json',
        collectedVia: null as null,
        activeAgentFiles: null as null,
        sourceOfTruth: null as null,
        canonicalEntrypoint: null as null,
        bundlePresent: false,
        primaryInitializationComplete: false,
        agentInitializationComplete: false,
        readyForTasks: false,
        agentInitializationPendingReason: null as null,
        missingProjectCommands: [] as string[],
        initAnswersError: null as null,
        liveVersionError: null as null,
        agentInitStateError: null as null,
        commandsRulePath: '/tmp/test/commands.md',
        recommendedNextCommand: 'garda setup',
        parityResult: {
            isSourceCheckout: false,
            isStale: false,
            violations: [] as string[],
            remediation: null as null
        },
        timelineTaskCount: 0,
        timelineHealthy: 0,
        timelineWarnings: [] as string[],
        providerComplianceResult: null as null,
        protectedManifestEvidence: null as null,
        initAnswersPathForDisplay: '/tmp/test/init-answers.json',
        initAnswersPresent: false,
        taskPresent: false,
        livePresent: false,
        usagePresent: false,
        agentInitStatePath: '/tmp/test/state.json',
        agentInitState: null as null
    };
    const output = formatStatusSnapshotCompact(snapshot as any);
    assert.ok(output.includes('GARDA_STATUS'), 'Not-ready compact must include full output');
    assert.ok(output.includes('RecommendedNextCommand'));
});
