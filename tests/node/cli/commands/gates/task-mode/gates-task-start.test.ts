import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { syncTaskQueueStatus, syncTaskQueueStatusDetailed } from '../../../../../../src/cli/commands/gate-flows/task/task-queue-sync';
import {
    handleEnterTaskMode
} from '../../../../../../src/cli/commands/gate-task-handlers';
import {
    runClassifyChangeCommand,
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runShellSmokePreflightCommand
} from '../../../../../../src/cli/commands/gates';
import {
    EXIT_GATE_FAILURE
} from '../../../../../../src/cli/exit-codes';
import {
    appendTaskEvent
} from '../../../../../../src/gate-runtime/task-events';
import {
    buildRulePackBindingSha256,
    getPostPreflightSequenceEvidence
} from '../../../../../../src/gates/rule-pack/rule-pack-binding';
import {
    appendPreflightClassifiedEvent,
    initializeGitRepo
} from '../../gate-test-seed-helpers';
import { createManagedTestTempDirectory, removeTempRepoWithRetry } from '../../gate-test-temp-manager';
import {
    buildRuleFileHashes,
    getLegacyPostPreflightRulePackFiles,
    getLegacyTaskEntryRulePackFiles,
    getRulePackRequiredEntryFiles
} from '../../../../../../src/gates/rule-pack/rule-pack-selection';
import {
    getRulePackEvidence
} from '../../../../../../src/gates/rule-pack/rule-pack-evidence';
import {
    runCliMain
} from '../../../../../../src/cli/main';
import {
    OPERATOR_CONFIRMATION_MAX_FUTURE_SKEW_MS
} from '../../../../../../src/core/operator-confirmation';

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function captureExpectedError(callback: () => void): Error {
    try {
        callback();
    } catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }
    assert.fail('Expected command to throw an error.');
}

async function captureExpectedAsyncError(callback: () => Promise<void>): Promise<Error> {
    try {
        await callback();
    } catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }
    assert.fail('Expected command to throw an error.');
}

function markAsSourceCheckout(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2), 'utf8');
}

const PROVIDER_ENTRYPOINT_BY_SOURCE: Record<string, string> = {
    Claude: 'CLAUDE.md',
    Codex: 'AGENTS.md',
    Gemini: 'GEMINI.md',
    Qwen: 'QWEN.md',
    GitHubCopilot: '.github/copilot-instructions.md',
    Windsurf: '.windsurf/rules/rules.md',
    Junie: '.junie/guidelines.md',
    Antigravity: '.antigravity/rules.md'
};

function withDefaultTaskModeRouting<T extends { repoRoot?: string; provider?: unknown; routedTo?: unknown }>(options: T): T {
    if (String(options.provider || '').trim() || String(options.routedTo || '').trim()) {
        return options;
    }
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return options;
    }

    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        const sourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
        const routedTo = PROVIDER_ENTRYPOINT_BY_SOURCE[sourceOfTruth];
        if (!sourceOfTruth || !routedTo) {
            return options;
        }
        return {
            ...options,
            provider: sourceOfTruth,
            routedTo
        };
    } catch {
        return options;
    }
}

function runEnterTaskMode(options: Parameters<typeof runEnterTaskModeCommand>[0]) {
    return runEnterTaskModeCommand(withDefaultTaskModeRouting({
        startBanner: 'Garda captures my mind',
        ...options
    }));
}

function createTempRepo(): string {
    const root = createManagedTestTempDirectory('repo-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    seedRuleFiles(root);
    initializeGitRepo(root);
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    return root;
}

function seedRuleFiles(repoRoot: string): void {
    const rulesRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules');
    fs.mkdirSync(rulesRoot, { recursive: true });
    const ruleFiles = [
        '00-core.md',
        '15-project-memory.md',
        '30-code-style.md',
        '35-strict-coding-rules.md',
        '40-commands.md',
        '50-structure-and-docs.md',
        '70-security.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ];
    for (const ruleFile of ruleFiles) {
        fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
    }
}

function getReviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function getOrchestratorRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator');
}

function seedTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | test | Update app flow | unassigned | 2026-03-28 | default | fixture |`
    ].join('\n'), 'utf8');
}

function seedProfilePolicyConfigs(repoRoot: string): void {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    for (const configFile of ['profiles.json', 'review-capabilities.json', 'review-catalog.json']) {
        fs.copyFileSync(
            path.resolve('template', 'config', configFile),
            path.join(configDir, configFile)
        );
    }
}

function readTaskQueueStatusFromTaskFile(repoRoot: string, taskId: string): string | null {
    const statusPattern = /\b(TODO|IN_PROGRESS|IN_REVIEW|DONE|BLOCKED)\b/i;
    const taskPath = path.join(repoRoot, 'TASK.md');
    const lines = fs.readFileSync(taskPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = trimmed.split('|').map((cell) => cell.trim()).filter(Boolean);
        if (cells.length < 2 || cells[0] !== taskId) {
            continue;
        }
        const statusMatch = statusPattern.exec(cells[1]);
        return statusMatch ? statusMatch[1].toUpperCase() : null;
    }
    return null;
}

it('status sync reflows the canonical Active Queue table after updating status', () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-703-format-sync';
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${taskId} | 🟦 TODO | P1 | queue | Short | agent | 2026-06-04 | balanced | preserve escaped \\| pipe |`,
        '| T-703-other | 🟨 IN_PROGRESS | P2 | task-queue/active-queue-formatting | Longer title | gpt-5.4 | 2026-06-04 | balanced | preserve row order |',
        '',
        '## Блок очереди',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| RU-1 | untouched | P1 | ru | lower table | me | 2026-06-04 | balanced | stays compact |'
    ].join('\n'), 'utf8');

    const result = syncTaskQueueStatusDetailed(repoRoot, taskId, 'IN_PROGRESS');
    const updated = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

    assert.equal(result.outcome, 'updated');
    assert.equal(result.previous_status, 'TODO');
    assert.match(updated, new RegExp(`\\| ${taskId}\\s+\\| 🟨 IN_PROGRESS \\| P1\\s+\\| queue\\s+\\| Short\\s+\\| agent\\s+\\| 2026-06-04 \\| balanced \\| preserve escaped \\\\\\\\| pipe \\|`));
    assert.match(updated, /\| T-703-other\s+\| 🟨 IN_PROGRESS \| P2\s+\| task-queue\/active-queue-formatting \| Longer title \| gpt-5\.4 \| 2026-06-04 \| balanced \| preserve row order\s+\|/);
    assert.ok(updated.includes('## Блок очереди\n| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |'));

    fs.rmSync(repoRoot, { recursive: true, force: true });
});

it('status sync fallback ignores lower human summary tables when no canonical queue exists', () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-LOWER-ONLY';
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## User Summary (RU)',
        '| Task ID | Status | Description | Notes |',
        '|---------|--------|-------------|-------|',
        `| ${taskId} | TODO | Lower-only row | Must not be machine-updated |`
    ].join('\n'), 'utf8');

    const result = syncTaskQueueStatusDetailed(repoRoot, taskId, 'IN_PROGRESS');
    const updated = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

    assert.equal(result.outcome, 'task_not_found');
    assert.ok(updated.includes(`| ${taskId} | TODO | Lower-only row | Must not be machine-updated |`));

    fs.rmSync(repoRoot, { recursive: true, force: true });
});

function seedInitAnswers(repoRoot: string, sourceOfTruth = 'Codex'): void {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    const routedTo = PROVIDER_ENTRYPOINT_BY_SOURCE[sourceOfTruth];
    fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
    fs.writeFileSync(initAnswersPath, JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: sourceOfTruth,
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: 'AGENTS.md'
    }, null, 2), 'utf8');
    if (routedTo) {
        const routedFilePath = path.join(repoRoot, routedTo);
        fs.mkdirSync(path.dirname(routedFilePath), { recursive: true });
        if (!fs.existsSync(routedFilePath)) {
            fs.writeFileSync(routedFilePath, '# routed workflow fixture\n', 'utf8');
        }
    }
}

function readTaskTimelineEvents(repoRoot: string, taskId: string): Array<Record<string, unknown>> {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    return fs.readFileSync(timelinePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function fileSha256ForTest(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadTaskEntryRulePack(repoRoot: string, taskId: string, taskModePath = '') {
    return runLoadRulePackCommand({
        repoRoot,
        taskId,
        stage: 'TASK_ENTRY',
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ],
        emitMetrics: false
    });
}

function writeTaskEntryRulePackArtifact(
    repoRoot: string,
    taskId: string,
    options: { ruleFiles: string[]; effectiveDepth: number; staleHash?: boolean }
): void {
    const loadedRuleHashes = buildRuleFileHashes(options.ruleFiles);
    if (options.staleHash) {
        loadedRuleHashes[options.ruleFiles[0]] = 'deadbeef';
    }
    const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    fs.writeFileSync(artifactPath, JSON.stringify({
        timestamp_utc: '2026-01-01T00:00:00.000Z',
        event_source: 'load-rule-pack',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        latest_stage: 'TASK_ENTRY',
        stages: {
            task_entry: {
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                stage: 'TASK_ENTRY',
                status: 'PASSED',
                outcome: 'PASS',
                actor: 'orchestrator',
                required_rule_files: options.ruleFiles,
                loaded_rule_files: options.ruleFiles,
                missing_rule_files: [],
                extra_rule_files: [],
                required_rule_hashes: buildRuleFileHashes(options.ruleFiles),
                loaded_rule_hashes: loadedRuleHashes,
                required_rule_count: options.ruleFiles.length,
                loaded_rule_count: options.ruleFiles.length,
                effective_depth: options.effectiveDepth,
                preflight_path: null,
                preflight_hash_sha256: null,
                preflight_rule_pack_binding_sha256: null,
                preflight_event_sequence: null,
                required_reviews: null,
                violations: []
            }
        }
    }, null, 2), 'utf8');
}

function writeLegacyTaskEntryRulePackArtifact(
    repoRoot: string,
    taskId: string,
    options: { staleHash?: boolean } = {}
): void {
    writeTaskEntryRulePackArtifact(repoRoot, taskId, {
        ruleFiles: getLegacyTaskEntryRulePackFiles(repoRoot),
        effectiveDepth: 1,
        staleHash: options.staleHash
    });
}

function writeLegacyPostPreflightRulePackArtifact(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    options: { effectiveDepth?: number } = {}
): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const riskAwareDepth = preflight.risk_aware_depth && typeof preflight.risk_aware_depth === 'object' && !Array.isArray(preflight.risk_aware_depth)
        ? preflight.risk_aware_depth as Record<string, unknown>
        : {};
    const effectiveDepth = options.effectiveDepth
        || (typeof riskAwareDepth.effective_depth === 'number' ? riskAwareDepth.effective_depth : 1);
    const requiredReviews = preflight.required_reviews as Record<string, boolean>;
    const legacyRuleFiles = getLegacyPostPreflightRulePackFiles(repoRoot, requiredReviews, effectiveDepth);
    const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const existingArtifact = fs.existsSync(artifactPath)
        ? JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>
        : {};
    const existingStages = existingArtifact.stages && typeof existingArtifact.stages === 'object' && !Array.isArray(existingArtifact.stages)
        ? existingArtifact.stages as Record<string, unknown>
        : {};
    const normalizedPreflightPath = preflightPath.replace(/\\/g, '/');
    const stages = {
        ...existingStages,
        post_preflight: {
            timestamp_utc: '2026-01-01T00:00:00.000Z',
            stage: 'POST_PREFLIGHT',
            status: 'PASSED',
            outcome: 'PASS',
            actor: 'orchestrator',
            required_rule_files: legacyRuleFiles,
            loaded_rule_files: legacyRuleFiles,
            missing_rule_files: [],
            extra_rule_files: [],
            required_rule_hashes: buildRuleFileHashes(legacyRuleFiles),
            loaded_rule_hashes: buildRuleFileHashes(legacyRuleFiles),
            required_rule_count: legacyRuleFiles.length,
            loaded_rule_count: legacyRuleFiles.length,
            effective_depth: effectiveDepth,
            preflight_path: normalizedPreflightPath,
            preflight_hash_sha256: fileSha256ForTest(preflightPath),
            preflight_rule_pack_binding_sha256: buildRulePackBindingSha256({
                repoRoot,
                preflightPath: normalizedPreflightPath,
                preflightPayload: preflight,
                effectiveDepth,
                requiredRuleFiles: legacyRuleFiles,
                requiredReviews
            }),
            preflight_event_sequence: null,
            required_reviews: requiredReviews,
            violations: []
        }
    };
    fs.writeFileSync(artifactPath, JSON.stringify({
        ...existingArtifact,
        timestamp_utc: '2026-01-01T00:00:00.000Z',
        event_source: 'load-rule-pack',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        latest_stage: 'POST_PREFLIGHT',
        stages
    }, null, 2), 'utf8');
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'RULE_PACK_LOADED',
        'PASS',
        'Legacy POST_PREFLIGHT rule-pack loaded.',
        {
            stage: 'POST_PREFLIGHT',
            preflight_path: normalizedPreflightPath,
            artifact_path: artifactPath.replace(/\\/g, '/')
        }
    );
}

describe('cli/commands/gates — task-start', () => {
    it('blocks app-workspace protected orchestrator scope when garda self-guard is on', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handoff';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Require explicit orchestrator-work handoff for protected planned scope',
                plannedChangedFiles: ['.github/agents/orchestrator.md']
            }));
        assert.match(
            error.message,
            /Garda self-guard is on for this application workspace/
        );
        assert.ok(!error.message.includes('gate enter-task-mode'));
        assert.ok(!error.message.includes('--planned-changed-file'));
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('uses the source-checkout CLI prefix in the orchestrator-work handoff command', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-source-checkout';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2), 'utf8');

        const error = captureExpectedError(() => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Require explicit orchestrator-work handoff for source-checkout protected scope',
                plannedChangedFiles: ['src/cli/main.ts']
            }));
        assert.match(
            error.message,
            new RegExp(
                `Planned task scope includes protected orchestrator files: src/cli/main\\.ts\\.` +
                `.*Suggested command: node bin/garda\\.js gate enter-task-mode` +
                `.*--repo-root '${escapeRegExp(path.resolve(repoRoot))}'` +
                `.*--orchestrator-work` +
                `.*--planned-changed-file 'src/cli/main\\.ts'`,
                'i'
            )
        );
        assert.ok(error.message.includes('--operator-confirmed yes'));
        assert.ok(error.message.includes('--operator-confirmed-at-utc "<ISO-8601 timestamp>"'));
        assert.ok(!error.message.includes('--requested-depth'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('preserves explicit requested depth in orchestrator-work handoff commands', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-explicit-depth';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2), 'utf8');

        const error = captureExpectedError(() => runEnterTaskMode({
                repoRoot,
                taskId,
                requestedDepth: 3,
                taskSummary: 'Preserve explicit requested depth in protected handoff',
                plannedChangedFiles: ['src/cli/main.ts']
            }));
        assert.match(error.message, /Suggested command: node bin\/garda\.js gate enter-task-mode/);
        assert.ok(error.message.includes("--requested-depth '3'"));
        assert.ok(error.message.includes('--orchestrator-work'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('preserves explicit effective depth without inventing requested depth in orchestrator-work handoff commands', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-explicit-effective-depth';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2), 'utf8');

        const error = captureExpectedError(() => runEnterTaskMode({
                repoRoot,
                taskId,
                effectiveDepth: 3,
                taskSummary: 'Preserve explicit effective depth in protected handoff',
                plannedChangedFiles: ['src/cli/main.ts']
            }));
        assert.match(error.message, /Suggested command: node bin\/garda\.js gate enter-task-mode/);
        assert.ok(!error.message.includes('--requested-depth'));
        assert.ok(error.message.includes("--effective-depth '3'"));
        assert.ok(error.message.includes('--orchestrator-work'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows fresh main-agent task mode without persisted start-banner telemetry', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900fresh-start-banner-optional';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const result = runEnterTaskModeCommand(withDefaultTaskModeRouting({
            repoRoot,
            taskId,
            taskSummary: 'Allow a fresh main-agent task run that omits optional start-banner telemetry'
        }));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines.some((line) => line.startsWith('StartBanner:')), false);
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(artifact.start_banner, null);
        const taskModeEvent = readTaskTimelineEvents(repoRoot, taskId)
            .find((event) => event.event_type === 'TASK_MODE_ENTERED') as Record<string, unknown>;
        assert.equal(((taskModeEvent.details as Record<string, unknown>) || {}).start_banner, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('runs enter-task-mode through CLI main and merges mixed planned scope hints', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-cli-main-smoke';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalStdoutWrite = process.stdout.write;
        const capturedStdout: string[] = [];
        process.exitCode = 0;
        process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
            capturedStdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8'));
            if (typeof encoding === 'function') {
                encoding();
            } else if (typeof callback === 'function') {
                callback();
            }
            return true;
        }) as typeof process.stdout.write;

        try {
            process.chdir(repoRoot);
            await runCliMain([
                'gate',
                'enter-task-mode',
                '--repo-root', repoRoot,
                '--task-id', taskId,
                '--task-summary', 'Exercise the full CLI main path for mixed planned scope hints',
                '--start-banner', 'Garda captures my mind',
                '--provider', 'Codex',
                '--routed-to', 'AGENTS.md',
                '--planned-changed-file', 'src/app.ts',
                '--planned-changed-files', 'src/feature.ts,src/app.ts'
            ]);
        } finally {
            process.stdout.write = originalStdoutWrite;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const output = capturedStdout.join('');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(timelinePath), true);
        assert.match(output, /TASK_MODE_ENTERED/);
        assert.match(output, /PlannedChangedFilesCount: 2/);

        removeTempRepoWithRetry(repoRoot);
    });

    it('parses --planned-changed-files through handleEnterTaskMode before emitting the orchestrator-work handoff', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handler-alias';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        markAsSourceCheckout(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = await captureExpectedAsyncError(() => handleEnterTaskMode([
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--task-summary', 'Require explicit orchestrator-work handoff through the CLI alias path',
            '--start-banner', 'Garda captures my mind',
            '--provider', 'Codex',
            '--routed-to', 'AGENTS.md',
            '--planned-changed-files', '.github/agents/orchestrator.md'
        ]));
        assert.match(
            error.message,
            new RegExp(
                `Planned task scope includes protected orchestrator files: \\.github/agents/orchestrator\\.md\\.` +
                `.*Suggested command: node bin/garda\\.js gate enter-task-mode` +
                `.*--repo-root '${escapeRegExp(path.resolve(repoRoot))}'` +
                `.*--orchestrator-work` +
                `.*--planned-changed-file '\\.github/agents/orchestrator\\.md'`,
                'i'
            )
        );
        assert.ok(error.message.includes('--operator-confirmed yes'));
        assert.ok(error.message.includes('--operator-confirmed-at-utc "<ISO-8601 timestamp>"'));
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('deduplicates mixed planned scope hints before emitting the orchestrator-work handoff', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handler-merged-aliases';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        markAsSourceCheckout(repoRoot);

        const error = await captureExpectedAsyncError(() => handleEnterTaskMode([
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--task-summary', 'Deduplicate mixed planned scope aliases before suggesting orchestrator-work handoff',
            '--start-banner', 'Garda captures my mind',
            '--provider', 'Codex',
            '--routed-to', 'AGENTS.md',
            '--planned-changed-file', '.github/agents/orchestrator.md',
            '--planned-changed-files', 'src/app.ts,.github/agents/orchestrator.md',
            '--planned-changed-file', 'src/app.ts'
        ]));
        assert.match(
            error.message,
            new RegExp(
                `Suggested command: node bin/garda\\.js gate enter-task-mode` +
                `.*--planned-changed-file '\\.github/agents/orchestrator\\.md'` +
                `.*--planned-changed-file 'src/app\\.ts'`,
                'i'
            )
        );
        assert.equal((error.message.match(/--planned-changed-file /g) || []).length, 2);
        assert.ok(error.message.includes('--operator-confirmed yes'));
        assert.ok(error.message.includes('--operator-confirmed-at-utc "<ISO-8601 timestamp>"'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects invalid planned-changed-files lists that escape the repo root', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handler-invalid-list';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = await captureExpectedAsyncError(() => handleEnterTaskMode([
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--task-summary', 'Reject planned changed files that escape repo root',
            '--start-banner', 'Garda captures my mind',
            '--provider', 'Codex',
            '--routed-to', 'AGENTS.md',
            '--planned-changed-files', 'src/app.ts,../outside.ts'
        ]));
        assert.match(error.message, /PlannedChangedFile must stay inside repo root/);
        assert.match(error.message, /outside\.ts/u);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows enter-task-mode when protected planned scope is declared with orchestrator-work', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-allowed';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        markAsSourceCheckout(repoRoot);

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow explicit orchestrator-work handoff for protected planned scope',
            orchestratorWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            plannedChangedFiles: ['.github/agents/orchestrator.md']
        });
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.includes('PlannedChangedFilesCount: 1'));
        assert.ok(result.outputLines.includes('PlannedProtectedFilesCount: 1'));
        assert.equal(artifact.orchestrator_work, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects orchestrator-work task mode without fresh operator confirmation timestamp', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-operator-confirm-time';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        markAsSourceCheckout(repoRoot);

        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Require fresh operator approval timestamp for protected planned scope',
                orchestratorWork: true,
                operatorConfirmed: 'yes',
                plannedChangedFiles: ['.github/agents/orchestrator.md']
            }),
            /enter-task-mode --orchestrator-work requires --operator-confirmed-at-utc/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects orchestrator-work task mode with an invalid operator confirmation timestamp format', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-invalid-confirm-time';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        markAsSourceCheckout(repoRoot);
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);

        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject invalid operator approval timestamp format for protected planned scope',
                orchestratorWork: true,
                operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: 'not-a-timestamp',
                plannedChangedFiles: ['.github/agents/orchestrator.md']
            }),
            /--operator-confirmed-at-utc must be a valid ISO-8601 timestamp/
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects orchestrator-work task mode without operator confirmation', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-operator-confirm';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        markAsSourceCheckout(repoRoot);

        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Require operator approval for protected planned scope',
                orchestratorWork: true,
                plannedChangedFiles: ['.github/agents/orchestrator.md']
            }),
            /enter-task-mode --orchestrator-work requires explicit operator confirmation/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects stale orchestrator-work operator confirmation timestamps', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-stale-confirm';
        const staleConfirmation = new Date(Date.now() - 11 * 60 * 1000).toISOString();
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        markAsSourceCheckout(repoRoot);

        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject stale operator approval for protected planned scope',
                orchestratorWork: true,
                operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: staleConfirmation,
                plannedChangedFiles: ['.github/agents/orchestrator.md']
            }),
            /enter-task-mode --orchestrator-work operator confirmation is stale/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects future-skewed orchestrator-work operator confirmation timestamps', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-future-confirm';
        const futureConfirmation = new Date(
            Date.now() + OPERATOR_CONFIRMATION_MAX_FUTURE_SKEW_MS + 30_000
        ).toISOString();
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        markAsSourceCheckout(repoRoot);
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);

        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject future-skewed operator approval for protected planned scope',
                orchestratorWork: true,
                operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: futureConfirmation,
                plannedChangedFiles: ['.github/agents/orchestrator.md']
            }),
            /enter-task-mode --orchestrator-work operator confirmation timestamp is in the future/
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('captures a dirty workspace baseline when entering task mode', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty-baseline';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# baseline routing fixture\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# changed routing fixture\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 13;\nconst b = 21;\nconsole.log(a + b);\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'unrelated.ts'), 'export const unrelated = true;\n', 'utf8');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Capture dirty workspace baseline'
        });
        assert.equal(result.exitCode, 0);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.deepEqual(
            artifact.dirty_workspace_baseline.changed_files,
            ['AGENTS.md', 'src/app.ts', 'src/unrelated.ts']
        );
        assert.equal(typeof artifact.dirty_workspace_baseline.file_hashes['AGENTS.md'], 'string');
        assert.equal(typeof artifact.dirty_workspace_baseline.file_hashes['src/app.ts'], 'string');
        assert.equal(typeof artifact.dirty_workspace_baseline.file_hashes['src/unrelated.ts'], 'string');
        assert.deepEqual(
            artifact.dirty_workspace_baseline.git_change_classification.effective_changed_files,
            ['AGENTS.md', 'src/app.ts', 'src/unrelated.ts']
        );
        assert.deepEqual(
            artifact.dirty_workspace_baseline.git_change_classification.unstaged_files,
            ['AGENTS.md', 'src/app.ts']
        );
        assert.deepEqual(
            artifact.dirty_workspace_baseline.git_change_classification.untracked_files,
            ['src/unrelated.ts']
        );
        assert.match(
            artifact.dirty_workspace_baseline.git_change_classification.normalization_rationale,
            /Git porcelain reported/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('loads rule-pack evidence and writes artifact', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900a';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });

        const result = loadTaskEntryRulePack(repoRoot, taskId);
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOADED');
        assert.equal(artifact.event_source, 'load-rule-pack');
        assert.equal(artifact.stages.task_entry.status, 'PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('loads compact TASK_ENTRY rule-pack evidence for depth 1 task mode', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900a-depth1';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 1,
            taskSummary: 'Update app flow'
        });

        const result = runLoadRulePackCommand({
            repoRoot,
            taskId,
            stage: 'TASK_ENTRY',
            loadedRuleFiles: [
                '00-core.md',
                '40-commands.md',
                '80-task-workflow.md'
            ],
            emitMetrics: false
        });
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOADED');
        assert.deepEqual(
            artifact.stages.task_entry.required_rule_files,
            getRulePackRequiredEntryFiles(repoRoot, 1)
        );
        assert.equal(artifact.stages.task_entry.required_rule_count, 3);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects compact TASK_ENTRY rule-pack evidence for strict depth 3 task mode', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900a-depth3';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 3,
            taskSummary: 'Update app flow'
        });

        const result = runLoadRulePackCommand({
            repoRoot,
            taskId,
            stage: 'TASK_ENTRY',
            loadedRuleFiles: [
                '00-core.md',
                '40-commands.md',
                '80-task-workflow.md'
            ],
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOAD_FAILED');
        assert.ok(result.outputLines.join('\n').includes('15-project-memory.md'));
        assert.ok(result.outputLines.join('\n').includes('90-skill-catalog.md'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects compact TASK_ENTRY artifact depth overrides for strict depth 3 task mode', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900a-depth3-forged-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 3,
            taskSummary: 'Update app flow'
        });
        writeTaskEntryRulePackArtifact(repoRoot, taskId, {
            ruleFiles: getRulePackRequiredEntryFiles(repoRoot, 1),
            effectiveDepth: 1
        });

        const evidence = getRulePackEvidence(repoRoot, taskId, 'TASK_ENTRY');

        assert.equal(evidence.evidence_status, 'EVIDENCE_RULE_SET_INVALID');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts legacy full TASK_ENTRY rule-pack evidence for depth 1 as a verified superset', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900a-legacy-depth1';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 1,
            taskSummary: 'Update app flow'
        });
        writeLegacyTaskEntryRulePackArtifact(repoRoot, taskId);

        const evidence = getRulePackEvidence(repoRoot, taskId, 'TASK_ENTRY');

        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.loaded_rule_files.length, 5);
        assert.equal(evidence.required_rule_files.length, 5);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts legacy full POST_PREFLIGHT rule-pack evidence for depth 1 as a verified superset', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900a-legacy-post-depth1';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        seedProfilePolicyConfigs(repoRoot);
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, '.agents', 'workflows', 'start-task.md'),
            '# Start Task\n',
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'fixture' }, null, 2), 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'),
            '#!/usr/bin/env node\n',
            'utf8'
        );
        initializeGitRepo(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 1,
            taskSummary: 'Update app flow'
        });
        runLoadRulePackCommand({
            repoRoot,
            taskId,
            stage: 'TASK_ENTRY',
            loadedRuleFiles: [
                '00-core.md',
                '40-commands.md',
                '80-task-workflow.md'
            ],
            emitMetrics: false
        });
        runHandshakeDiagnosticsCommand({
            repoRoot,
            taskId,
            emitMetrics: false
        });
        runShellSmokePreflightCommand({
            repoRoot,
            taskId,
            emitMetrics: false
        });
        runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Update app flow',
            changedFiles: ['src/app.ts'],
            emitMetrics: false
        });
        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        writeLegacyPostPreflightRulePackArtifact(repoRoot, taskId, preflightPath);

        const evidence = getRulePackEvidence(repoRoot, taskId, 'POST_PREFLIGHT', { preflightPath });
        const sequenceEvidence = getPostPreflightSequenceEvidence(repoRoot, taskId, preflightPath);

        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.binding_equivalent_to_current_preflight, true);
        assert.deepEqual(sequenceEvidence.violations, []);
        assert.equal(sequenceEvidence.binding_equivalent_to_current_preflight, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps stale hash validation for legacy full TASK_ENTRY compatibility', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900a-legacy-stale';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 1,
            taskSummary: 'Update app flow'
        });
        writeLegacyTaskEntryRulePackArtifact(repoRoot, taskId, { staleHash: true });

        const evidence = getRulePackEvidence(repoRoot, taskId, 'TASK_ENTRY');

        assert.equal(evidence.evidence_status, 'EVIDENCE_LOADED_RULE_STALE');
        assert.ok(evidence.stale_loaded_rule_file);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails preflight classification when rule-pack evidence is missing', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900b';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });

        assert.throws(
            () => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskId,
                taskIntent: 'Update app flow',
                emitMetrics: false
            }),
            /Rule-pack evidence missing/
        );

        const eventTypes = readTaskTimelineEvents(repoRoot, taskId).map((event) => event.event_type);
        assert.ok(eventTypes.includes('PREFLIGHT_STARTED'));
        assert.ok(eventTypes.includes('PREFLIGHT_FAILED'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('auto-emits plan, status, and routing events when entering task mode', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot, 'Qwen');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });

        assert.equal(result.exitCode, 0);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const eventTypes = events.map((event) => event.event_type);
        assert.deepEqual(eventTypes, [
            'TASK_MODE_ENTERED',
            'PLAN_CREATED',
            'STATUS_CHANGED',
            'PROVIDER_ROUTING_DECISION'
        ]);
        const statusDetails = events[2].details as Record<string, unknown>;
        const routingDetails = events[3].details as Record<string, unknown>;
        assert.equal(statusDetails.previous_status, 'TODO');
        assert.equal(statusDetails.new_status, 'IN_PROGRESS');
        assert.equal(routingDetails.provider, 'Qwen');
        assert.equal(routingDetails.routed_to, 'QWEN.md');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_PROGRESS');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-900c\s*\|\s*🟨 IN_PROGRESS\s*\|/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('syncTaskQueueStatus canonicalizes plain TASK.md rows across lifecycle states', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-plain';
        seedTaskQueue(repoRoot, taskId, 'TODO');

        assert.equal(syncTaskQueueStatus(repoRoot, taskId, 'IN_PROGRESS'), true);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_PROGRESS');
        let taskFile = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskFile, /\|\s*T-900c-plain\s*\|\s*🟨 IN_PROGRESS\s*\|/);

        assert.equal(syncTaskQueueStatus(repoRoot, taskId, 'IN_REVIEW'), true);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        taskFile = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskFile, /\|\s*T-900c-plain\s*\|\s*🟧 IN_REVIEW\s*\|/);

        assert.equal(syncTaskQueueStatus(repoRoot, taskId, 'DONE'), true);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        taskFile = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskFile, /\|\s*T-900c-plain\s*\|\s*🟩 DONE\s*\|/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('syncTaskQueueStatus preserves escaped pipes in TASK.md notes cells', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-escaped-notes';
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
            `| ${taskId} | TODO | P1 | test | Update app flow | unassigned | 2026-03-28 | default | before \\| blocked_reason_code=ESCAPED_PIPE |`
        ].join('\n'), 'utf8');

        assert.equal(syncTaskQueueStatus(repoRoot, taskId, 'IN_PROGRESS'), true);

        const taskFile = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskFile, /\|\s*T-900c-escaped-notes\s*\|\s*🟨 IN_PROGRESS\s*\|/);
        assert.ok(taskFile.includes('before \\| blocked_reason_code=ESCAPED_PIPE'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('uses explicit provider override for task-mode routing evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-provider';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Qwen');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# routed workflow fixture\n', 'utf8');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });

        assert.equal(result.exitCode, 0);
        const taskModeArtifact = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8'));
        const routingDetails = (readTaskTimelineEvents(repoRoot, taskId).at(-1)?.details || {}) as Record<string, unknown>;
        assert.equal(taskModeArtifact.provider, 'Codex');
        assert.equal(taskModeArtifact.routed_to, 'AGENTS.md');
        assert.equal(routingDetails.provider, 'Codex');
        assert.equal(routingDetails.routed_to, 'AGENTS.md');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects legacy fallback and does not reuse stale task-mode routing evidence on a new task-mode entry', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-stale-routing';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, JSON.stringify({
            schema_version: 1,
            timestamp_utc: '2026-04-17T08:00:00.000Z',
            event_source: 'enter-task-mode',
            status: 'PASS',
            outcome: 'PASS',
            task_id: taskId,
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'stale runtime identity',
            provider: 'Qwen',
            execution_provider_source: 'task_mode',
            runtime_identity_status: 'resolved',
            routed_to: 'QWEN.md'
        }, null, 2), 'utf8');

        const error = captureExpectedError(() => runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Refresh runtime identity without trusting stale task-mode evidence'
        }));

        assert.match(error.message, /Runtime execution identity is 'missing' at task-mode entry/i);
        assert.match(error.message, /--provider\s+['"]?<provider>['"]?/i);
        assert.match(error.message, /--routed-to ['"]?AGENTS\.md['"]?/i);
        const staleArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(staleArtifact.provider, 'Qwen');
        assert.equal(staleArtifact.routed_to, 'QWEN.md');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps custom task-mode artifact paths in task-mode entry missing-identity remediation', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-stale-routing-custom-artifact';
        const customTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-custom-task-mode.json`);
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const error = captureExpectedError(() => runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Preserve custom task-mode artifact path in legacy-fallback remediation',
            artifactPath: customTaskModePath
        }));

        assert.match(error.message, /Runtime execution identity is 'missing' at task-mode entry/i);
        assert.match(error.message, /--artifact-path/i);
        assert.match(error.message, new RegExp(escapeRegExp(customTaskModePath)));
        assert.equal(fs.existsSync(customTaskModePath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when explicit runtime identity is contradictory', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-contradictory-routing';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject contradictory runtime identity at task-mode entry',
            provider: 'Codex',
            routedTo: 'QWEN.md'
        }));

        assert.match(error.message, /Runtime execution identity is 'contradictory' at task-mode entry/i);
        assert.match(error.message, /contradicts routed path 'QWEN\.md'/i);
        assert.match(error.message, /--task-summary "<task-summary>"/i);
        assert.doesNotMatch(error.message, /--routed-to ['"]?QWEN\.md['"]?/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when an explicit provider override is unrecognized even if routed identity resolves', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-invalid-provider-override';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject malformed explicit provider override at task-mode entry',
            provider: 'NotAProvider',
            routedTo: 'AGENTS.md'
        }));

        assert.match(error.message, /Runtime execution identity is 'contradictory' at task-mode entry/i);
        assert.match(error.message, /provider override 'NotAProvider' is not recognized/i);
        assert.match(error.message, /--task-summary "<task-summary>"/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when an explicit routed-to override is unrecognized even if provider resolves', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-invalid-route-override';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject malformed explicit routed-to override at task-mode entry',
            provider: 'Codex',
            routedTo: 'NOT-A-REAL-ROUTE.md'
        }));

        assert.match(error.message, /Runtime execution identity is 'contradictory' at task-mode entry/i);
        assert.match(error.message, /route override 'NOT-A-REAL-ROUTE\.md' is not a recognized provider bridge or canonical entrypoint/i);
        assert.match(error.message, /--routed-to "<provider-bridge-or-entrypoint>"/i);
        assert.doesNotMatch(error.message, /--routed-to ['"]?NOT-A-REAL-ROUTE\.md['"]?/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts enter-task-mode when runtime identity is pinned with an explicit provider session', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-direct-provider-launch-blocked';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow direct provider task-mode entry when runtime identity is explicit',
            provider: 'Codex'
        });

        assert.equal(result.exitCode, 0);
        const taskModeArtifact = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8'));
        assert.equal(taskModeArtifact.provider, 'Codex');
        assert.equal(taskModeArtifact.execution_provider_source, 'explicit_provider');
        assert.equal(taskModeArtifact.reviewer_subagent_launch_status, 'launchable');
        assert.match(String(taskModeArtifact.reviewer_subagent_launch_reason || ''), /explicit provider selection/i);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts enter-task-mode when a bridge-based provider uses its root entrypoint', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-bridge-provider-root-entrypoint';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'GitHubCopilot');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow bridge provider task-mode entry through root entrypoint',
            provider: 'GitHubCopilot',
            routedTo: '.github/copilot-instructions.md'
        });

        assert.equal(result.exitCode, 0);
        const taskModeArtifact = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8'));
        assert.equal(taskModeArtifact.provider, 'GitHubCopilot');
        assert.equal(taskModeArtifact.execution_provider_source, 'provider_entrypoint');
        assert.equal(taskModeArtifact.routed_to, '.github/copilot-instructions.md');
        assert.equal(taskModeArtifact.reviewer_subagent_launch_status, 'launchable');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('normalizes explicit provider tool aliases before writing task-mode evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-provider-tool-alias';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'GitHubCopilot');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Normalize provider tool alias at task-mode entry',
            provider: 'github-copilot-cli',
            routedTo: '.github/copilot-instructions.md'
        });

        assert.equal(result.exitCode, 0);
        const taskModeArtifact = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8'));
        assert.equal(taskModeArtifact.provider, 'GitHubCopilot');
        assert.equal(taskModeArtifact.canonical_source_of_truth, 'GitHubCopilot');
        assert.equal(taskModeArtifact.execution_provider_source, 'provider_entrypoint');
        assert.equal(taskModeArtifact.runtime_identity_status, 'resolved');
        assert.deepEqual(taskModeArtifact.runtime_identity_violations, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when runtime identity is missing', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-missing-routing';
        seedTaskQueue(repoRoot, taskId, 'TODO');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject missing runtime identity at task-mode entry'
        }));

        assert.match(error.message, /Canonical SourceOfTruth is missing at task-mode entry/i);
        assert.match(error.message, /setup\/reinit/i);
        assert.match(error.message, /--task-summary "<task-summary>"/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps custom task-mode artifact paths when canonical SourceOfTruth is missing at task-mode entry', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-missing-routing-custom-artifact';
        const customTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-custom-task-mode.json`);
        seedTaskQueue(repoRoot, taskId, 'TODO');

        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Preserve custom task-mode artifact path when canonical owner files are missing',
            artifactPath: customTaskModePath
        }));

        assert.match(error.message, /Canonical SourceOfTruth is missing at task-mode entry/i);
        assert.match(error.message, /--artifact-path/i);
        assert.match(error.message, new RegExp(escapeRegExp(customTaskModePath)));
        assert.equal(fs.existsSync(customTaskModePath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when canonical SourceOfTruth is missing even with explicit runtime identity', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-missing-canonical-owner';
        seedTaskQueue(repoRoot, taskId, 'TODO');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Reject task start when canonical owner files are missing',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        }));

        assert.match(error.message, /Canonical SourceOfTruth is missing at task-mode entry/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rolls back task-mode artifact when TASK_MODE_ENTERED append fails', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900lock';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, `.${taskId}.lock`);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const artifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-task-mode.json`);
        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Update app flow'
            }),
            /TASK_MODE_ENTERED/
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails task-mode entry when the review artifact path is already locked', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900artifact-lock';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-task-mode.json`);
        const lockPath = `${artifactPath}.lock`;
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Update app flow'
            }),
            /Timed out acquiring file lock/
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prints remediation command on POST_PREFLIGHT failure with missing rule files', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900post-preflight-remediation';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Test POST_PREFLIGHT remediation output' });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: taskId,
            detection_source: 'explicit_changed_files',
            mode: 'FULL_PATH',
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true, db: false, security: false, refactor: false,
                api: false, test: false, performance: false, infra: false, dependency: false
            },
            triggers: {},
            changed_files: ['src/app.ts']
        }, null, 2), 'utf8');
        appendPreflightClassifiedEvent(repoRoot, taskId, preflightPath);

        // Reviewer rule files are intentionally excluded from reviewer handoffs. Omit one
        // main-agent POST_PREFLIGHT rule to exercise the remediation command instead.
        const result = runLoadRulePackCommand({
            repoRoot,
            taskId,
            stage: 'POST_PREFLIGHT',
            preflightPath,
            loadedRuleFiles: ['00-core.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'],
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOAD_FAILED');
        const remediationIdx = result.outputLines.indexOf('Remediation:');
        assert.notEqual(remediationIdx, -1, 'Expected a Remediation: line in the output');
        const remediationCommand = result.outputLines[remediationIdx + 1] ?? '';
        assert.match(remediationCommand, /gate load-rule-pack/);
        assert.match(remediationCommand, /--repo-root/);
        assert.match(remediationCommand, new RegExp(`--task-id.*${taskId}`));
        assert.match(remediationCommand, /--stage.*POST_PREFLIGHT/);
        assert.match(remediationCommand, /--preflight-path/);
        // The current main-agent POST_PREFLIGHT set is the five entry rules.
        const loadedRuleFileMatches = remediationCommand.match(/--loaded-rule-file/g);
        assert.equal(loadedRuleFileMatches?.length ?? 0, 5, 'Expected 5 --loaded-rule-file flags');
        assert.match(remediationCommand, /15-project-memory\.md/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
