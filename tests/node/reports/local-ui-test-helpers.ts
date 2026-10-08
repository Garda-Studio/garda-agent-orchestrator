import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach } from 'node:test';
import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import { computeProtectedSnapshotDigest } from '../../../src/gates/protected-control-plane/protected-control-plane';

interface ClosableLocalUiServer {
    close: () => Promise<void>;
}

const localUiTempRepos = new Set<string>();
const localUiTempRemovalOptions = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };

afterEach(() => {
    let firstError: unknown = null;
    for (const repoRoot of Array.from(localUiTempRepos)) {
        try {
            removeLocalUiTempRepo(repoRoot);
        } catch (error: unknown) {
            if (firstError === null) {
                firstError = error;
            }
        }
    }
    if (firstError !== null) {
        throw firstError;
    }
});

export function makeLocalUiTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-local-ui-server-'));
    localUiTempRepos.add(repoRoot);
    return repoRoot;
}

export function writeLocalUiRepoFixture(repoRoot: string): void {
    writeLocalUiTaskQueue(repoRoot, 'T-100', 'Build UI');
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Agent instructions\n', 'utf8');
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(buildDefaultWorkflowConfig(), null, 2));
    writeLocalUiProfilesFixture(repoRoot);
    const pathsConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
    fs.writeFileSync(pathsConfigPath, JSON.stringify({
        ordinary_doc_paths: ['CHANGELOG.md']
    }, null, 2));
    fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
    const runtimeRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'init-answers.json'), JSON.stringify({
        AssistantLanguage: 'Russian',
        AssistantBrevity: 'detailed',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'true',
        ClaudeOrchestratorFullAccess: 'true',
        TokenEconomyEnabled: 'true',
        ProviderMinimalism: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE',
        ActiveAgentFiles: 'AGENTS.md'
    }, null, 2));
    fs.writeFileSync(path.join(runtimeRoot, 'agent-init-state.json'), JSON.stringify({
        Version: 1,
        UpdatedAt: '2026-05-17T00:00:00.000Z',
        OrchestratorVersion: '1.1.0',
        AssistantLanguage: 'Russian',
        SourceOfTruth: 'Codex',
        AssistantLanguageConfirmed: true,
        ActiveAgentFilesConfirmed: true,
        ProjectRulesUpdated: true,
        SkillsPromptCompleted: true,
        OrdinaryDocPathsConfirmed: true,
        OrdinaryDocPaths: [],
        VerificationPassed: true,
        ManifestValidationPassed: true,
        ActiveAgentFiles: ['AGENTS.md'],
        LastSeededFullSuiteCommand: 'npm test',
        ProjectMemoryInitialized: true,
        ProjectMemoryValidated: true,
        ProjectMemoryMode: 'strict',
        ProjectMemoryDir: 'live/docs/project-memory',
        ProjectMemoryReadFirst: ['live/docs/project-memory/README.md', 'live/docs/project-memory/compact.md'],
        ProjectMemorySummaryRule: 'live/docs/agent-rules/15-project-memory.md',
        ProjectMemoryBootstrapReport: 'runtime/project-memory/bootstrap-report.json',
        ProjectMemoryWarnings: []
    }, null, 2));
    const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    for (const fileName of ['README.md', 'compact.md', 'context.md', 'stack.md', 'architecture.md', 'module-map.md', 'commands.md', 'conventions.md', 'decisions.md', 'risks.md']) {
        fs.writeFileSync(path.join(memoryRoot, fileName), `# ${fileName}\n\nMemory for ${fileName}.\n`);
    }
}

export function buildLocalUiProfilesFixture(): Record<string, unknown> {
    return {
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Default profile',
                depth: 2,
                review_policy: {
                    code: true,
                    db: 'auto',
                    security: 'auto',
                    refactor: 'auto',
                    api: 'auto',
                    test: true,
                    performance: 'auto',
                    infra: 'auto',
                    dependency: 'auto'
                },
                review_remediation_mode_policy: {
                    schema_version: 2,
                    policy_id: 'conservative_review_remediation_mode_v1',
                    initial_review_mode: 'FULL',
                    delta_eligible_review_types: [
                        'api',
                        'code',
                        'db',
                        'dependency',
                        'infra',
                        'performance',
                        'refactor',
                        'security',
                        'test'
                    ],
                    force_full_categories: ['ambiguous', 'generated_churn', 'global'],
                    max_delta_changed_files: 4,
                    max_delta_changed_lines: 240,
                    max_consecutive_delta_reviews: 3
                },
                token_economy: {
                    enabled: true,
                    strip_examples: true,
                    strip_code_blocks: true,
                    scoped_diffs: true,
                    compact_reviewer_output: true
                },
                skills: { auto_suggest: true }
            },
            fast: {
                description: 'Fast profile',
                depth: 1,
                review_policy: {
                    code: 'auto',
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: 'auto',
                    performance: false,
                    infra: false,
                    dependency: false
                },
                token_economy: {
                    enabled: true,
                    strip_examples: true,
                    strip_code_blocks: true,
                    scoped_diffs: true,
                    compact_reviewer_output: true
                },
                skills: { auto_suggest: false }
            },
            strict: {
                description: 'Strict profile',
                depth: 3,
                review_policy: {
                    code: true,
                    db: 'auto',
                    security: true,
                    refactor: 'auto',
                    api: 'auto',
                    test: true,
                    performance: true,
                    infra: 'auto',
                    dependency: 'auto'
                },
                token_economy: {
                    enabled: true,
                    strip_examples: false,
                    strip_code_blocks: false,
                    scoped_diffs: true,
                    compact_reviewer_output: false
                },
                skills: { auto_suggest: true }
            },
            'docs-only': {
                description: 'Docs profile',
                depth: 1,
                review_policy: {
                    code: false,
                    db: false,
                    security: false,
                    refactor: false,
                    api: false,
                    test: false,
                    performance: false,
                    infra: false,
                    dependency: false
                },
                token_economy: {
                    enabled: true,
                    strip_examples: true,
                    strip_code_blocks: true,
                    scoped_diffs: false,
                    compact_reviewer_output: true
                },
                skills: { auto_suggest: false }
            }
        },
        user_profiles: {}
    };
}

export function writeLocalUiProfilesFixture(repoRoot: string): void {
    const liveConfigDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    const templateConfigDir = path.join(repoRoot, 'garda-agent-orchestrator', 'template', 'config');
    const fixture = buildLocalUiProfilesFixture();
    fs.mkdirSync(liveConfigDir, { recursive: true });
    fs.mkdirSync(templateConfigDir, { recursive: true });
    fs.writeFileSync(path.join(liveConfigDir, 'profiles.json'), JSON.stringify(fixture, null, 2), 'utf8');
    fs.writeFileSync(path.join(templateConfigDir, 'profiles.json'), JSON.stringify(fixture, null, 2), 'utf8');
}

export function writeLocalUiTaskQueue(repoRoot: string, taskId: string, title: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${taskId} | TODO | P2 | ui/report | ${title} | gpt-5.4 | 2026-05-17 | balanced | Uses lazy details |`
    ].join('\n'));
}

export function setLocalUiTaskResetEnabled(repoRoot: string, enabled: boolean): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ReturnType<typeof buildDefaultWorkflowConfig>;
    parsed.task_reset.enabled = enabled;
    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2));
}

export function writeLocalUiTaskResetAuditRecord(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const configText = fs.readFileSync(configPath, 'utf8');
    const configSha = createHash('sha256').update(configText, 'utf8').digest('hex');
    const auditPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'workflow-config-audit.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    const auditRecord = {
        schema_version: 1,
        event_source: 'workflow-config-set',
        timestamp_utc: new Date().toISOString(),
        actor: 'operator_command',
        command: 'workflow set',
        config_path: configPath.replace(/\\/gu, '/'),
        changed_fields: ['task_reset.enabled'],
        before_sha256: configSha,
        after_sha256: configSha
    };
    const auditLine = JSON.stringify(auditRecord);
    fs.appendFileSync(auditPath, `${auditLine}\n`, 'utf8');

    const receiptPayload = {
        event_source: 'task-reset-enablement-receipt',
        command: 'workflow set',
        config_path: auditRecord.config_path,
        changed_fields: auditRecord.changed_fields,
        after_sha256: auditRecord.after_sha256,
        audit_record_sha256: createHash('sha256').update(auditLine, 'utf8').digest('hex')
    };
    const receiptText = `${JSON.stringify({
        schema_version: 1,
        ...receiptPayload,
        timestamp_utc: new Date().toISOString(),
        actor: 'operator_command',
        receipt_sha256: createHash('sha256').update(JSON.stringify(receiptPayload), 'utf8').digest('hex')
    }, null, 2)}\n`;
    const receiptPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'task-reset-enablement-receipt.json');
    fs.writeFileSync(receiptPath, receiptText, 'utf8');
    const protectedSnapshot = {
        'garda-agent-orchestrator/live/config/task-reset-enablement-receipt.json': createHash('sha256').update(receiptText, 'utf8').digest('hex')
    };
    fs.writeFileSync(path.join(path.dirname(auditPath), 'protected-control-plane-manifest.json'), `${JSON.stringify({
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        timestamp_utc: new Date().toISOString(),
        workspace_root: repoRoot.replace(/\\/gu, '/'),
        orchestrator_root: path.join(repoRoot, 'garda-agent-orchestrator').replace(/\\/gu, '/'),
        protected_roots: ['garda-agent-orchestrator/live/config/task-reset-enablement-receipt.json'],
        protected_snapshot: protectedSnapshot,
        protected_snapshot_sha256: computeProtectedSnapshotDigest(protectedSnapshot),
        is_source_checkout: false
    }, null, 2)}\n`, 'utf8');
}

export function removeLocalUiTempRepo(repoRoot: string | null | undefined): void {
    if (!repoRoot) {
        return;
    }
    fs.rmSync(repoRoot, localUiTempRemovalOptions);
    localUiTempRepos.delete(repoRoot);
}

export async function cleanupLocalUiTestResources(options: {
    repoRoot?: string | null;
    server?: ClosableLocalUiServer | null;
    netServers?: Array<net.Server | null | undefined>;
}): Promise<void> {
    let firstError: unknown = null;
    const capture = (error: unknown) => {
        if (firstError === null) {
            firstError = error;
        }
    };

    if (options.server) {
        try {
            await options.server.close();
        } catch (error: unknown) {
            if (!isAlreadyClosedServerError(error)) {
                capture(error);
            }
        }
    }
    for (const server of options.netServers || []) {
        if (!server) {
            continue;
        }
        try {
            await closeNetServer(server);
        } catch (error: unknown) {
            if (!isAlreadyClosedServerError(error)) {
                capture(error);
            }
        }
    }
    try {
        if (options.repoRoot) {
            await fs.promises.rm(options.repoRoot, localUiTempRemovalOptions);
            localUiTempRepos.delete(options.repoRoot);
        }
    } catch (error: unknown) {
        capture(error);
    }

    if (firstError !== null) {
        throw firstError;
    }
}

function closeNetServer(server: net.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

function isAlreadyClosedServerError(error: unknown): boolean {
    return error instanceof Error
        && 'code' in error
        && (error as Error & { code?: string }).code === 'ERR_SERVER_NOT_RUNNING';
}
