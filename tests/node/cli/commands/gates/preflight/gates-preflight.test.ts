import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    EXIT_GATE_FAILURE
} from '../../../../../../src/cli/exit-codes';
import {
    runClassifyChangeCommand as runSourceClassifyChangeCommand,
    runCompileGateCommand,
    runLoadRulePackCommand,
} from '../../../../../../src/cli/commands/gates';
import { serializeTaskPlan } from '../../../../../../src/schemas/task-plan';
import {
    assertGateChainDecision,
    runCliWithCapturedOutput,
    writeBudgetOutputFilters
} from '../../gate-test-helpers';
import {
    appendTaskEvent,
    buildEventIntegrityHash
} from '../../../../../../src/gate-runtime/task-events';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import { formatReviewFollowUpTaskClosurePolicyMetadata } from '../../../../../../src/core/review-follow-up-task-closure-policy';
import {
    computeTaskProfilePolicySnapshotHash,
    type TaskProfilePolicySnapshot
} from '../../../../../../src/policy/task-profile-policy-snapshot';
import {
    captureExpectedError,
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    loadTaskEntryRulePack,
    readTaskTimelineEvents,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeHandshakeArtifact
} from './gates-preflight-fixtures';

const TEST_COMPILE_GATE_COMMAND = 'node -e "console.log(\'build ok\')"';

function runClassifyChangeCommand(
    options: Parameters<typeof runSourceClassifyChangeCommand>[0]
): ReturnType<typeof runSourceClassifyChangeCommand> {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const changedFiles = Array.isArray(options.changedFiles)
        ? options.changedFiles.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean)
        : [];
    const materializedFiles = changedFiles
        .filter((relativePath) => (
            !path.isAbsolute(relativePath)
            && !/^[A-Za-z]:\//u.test(relativePath)
            && !relativePath.startsWith('../')
            && !relativePath.includes('/../')
            && !relativePath.startsWith('garda-agent-orchestrator/runtime/')
        ))
        .map((relativePath) => ({
            relativePath,
            absolutePath: path.resolve(repoRoot, relativePath)
        }))
        .filter((entry) => {
            const relativeToRoot = path.relative(repoRoot, entry.absolutePath);
            return Boolean(relativeToRoot) && !relativeToRoot.startsWith('..') && !path.isAbsolute(relativeToRoot);
        });

    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        const snapshots = materializedFiles.map((entry) => {
            const existed = fs.existsSync(entry.absolutePath);
            const content = existed ? fs.readFileSync(entry.absolutePath) : null;
            fs.mkdirSync(path.dirname(entry.absolutePath), { recursive: true });
            fs.writeFileSync(entry.absolutePath, Buffer.alloc(0));
            return { ...entry, existed, content };
        });
        try {
            initializeGitRepo(repoRoot);
        } finally {
            for (const snapshot of snapshots) {
                if (snapshot.existed && snapshot.content) {
                    fs.writeFileSync(snapshot.absolutePath, snapshot.content);
                } else if (fs.existsSync(snapshot.absolutePath)) {
                    fs.unlinkSync(snapshot.absolutePath);
                }
            }
        }
    } else {
        for (const entry of materializedFiles) {
            const status = childProcess.spawnSync(
                'git',
                ['status', '--porcelain', '--', entry.relativePath],
                { cwd: repoRoot, windowsHide: true, encoding: 'utf8' }
            );
            assert.equal(status.status, 0, String(status.stderr || status.stdout || '').trim());
            if (String(status.stdout || '').trim()) {
                continue;
            }
            fs.mkdirSync(path.dirname(entry.absolutePath), { recursive: true });
            if (fs.existsSync(entry.absolutePath)) {
                fs.appendFileSync(entry.absolutePath, '\n', 'utf8');
            } else if (entry.relativePath.endsWith('workflow-config.json')) {
                fs.writeFileSync(
                    entry.absolutePath,
                    `${JSON.stringify(buildDefaultWorkflowConfig(), null, 2)}\n`,
                    'utf8'
                );
            } else if (entry.relativePath.endsWith('.json')) {
                fs.writeFileSync(entry.absolutePath, '{}\n', 'utf8');
            } else {
                fs.writeFileSync(entry.absolutePath, `// preflight fixture for ${entry.relativePath}\n`, 'utf8');
            }
        }
    }

    return runSourceClassifyChangeCommand(options);
}

function computeTaskTextSha256(taskText: string): string {
    return createHash('sha256').update(taskText.trim(), 'utf8').digest('hex');
}

function writeConfiguredCompileGate(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.compile_gate.command = TEST_COMPILE_GATE_COMMAND;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(workflowConfig, null, 2)}\n`, 'utf8');
}

function seedNodeBackendOptionalSkillFixture(
    repoRoot: string,
    policyMode: 'advisory' | 'required' | 'strict' | 'off' = 'advisory'
): string {
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    const configDir = path.join(orchestratorRoot, 'live', 'config');
    const skillRoot = path.join(orchestratorRoot, 'live', 'skills', 'node-backend');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'garda.config.json'),
        JSON.stringify({
            version: 1,
            configs: {
                'optional-skill-selection-policy': 'optional-skill-selection-policy.json',
                'skill-packs': 'skill-packs.json'
            }
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'skill-packs.json'),
        JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'optional-skill-selection-policy.json'),
        JSON.stringify({ version: 1, mode: policyMode }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(skillRoot, 'skill.json'),
        JSON.stringify({
            id: 'node-backend',
            pack: 'node-backend',
            name: 'Node Backend',
            summary: 'Node backend specialist for request validation and API work.',
            tags: ['node', 'backend', 'api'],
            aliases: ['node-backend', 'node'],
            task_signals: ['request validation', 'api endpoint', 'node-backend'],
            changed_path_signals: ['src/api/', 'orders.ts'],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Node Backend\n\nUse for Node backend API work.\n', 'utf8');
    return path.join(skillRoot, 'SKILL.md');
}

function seedDevopsOptionalSkillFixture(
    repoRoot: string,
    policyMode: 'required' | 'strict' = 'required'
): string {
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    const configDir = path.join(orchestratorRoot, 'live', 'config');
    const skillRoot = path.join(orchestratorRoot, 'live', 'skills', 'devops-k8s');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'garda.config.json'),
        JSON.stringify({
            version: 1,
            configs: {
                'optional-skill-selection-policy': 'optional-skill-selection-policy.json',
                'skill-packs': 'skill-packs.json'
            }
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'skill-packs.json'),
        JSON.stringify({ version: 1, installed_packs: ['devops-k8s'] }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'optional-skill-selection-policy.json'),
        JSON.stringify({ version: 1, mode: policyMode }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(skillRoot, 'skill.json'),
        JSON.stringify({
            id: 'devops-k8s',
            pack: 'devops-k8s',
            name: 'DevOps K8s',
            summary: 'Container and Kubernetes delivery specialist.',
            tags: ['kubernetes', 'docker', 'deployment'],
            aliases: ['k8s', 'kubernetes', 'docker'],
            task_signals: ['deployment', 'rollout', 'container'],
            changed_path_signals: ['k8s/', 'helm/', 'deploy/', 'Dockerfile'],
            references: [],
            cost_hint: 'medium',
            priority: 85,
            autoload: 'suggest'
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# DevOps K8s\n\nUse for deployment and container work.\n', 'utf8');
    fs.writeFileSync(
        path.join(configDir, 'skills-index.json'),
        JSON.stringify({
            version: 1,
            packs: [{
                id: 'devops-k8s',
                label: 'DevOps K8s',
                description: 'Container and Kubernetes delivery specialist.',
                tags: ['kubernetes', 'docker', 'deployment'],
                recommended_for: ['container deployment'],
                skill_count: 1,
                ready_skill_count: 1,
                placeholder_skill_count: 0,
                implemented: true,
                collides_with_baseline: false
            }],
            skills: [{
                id: 'devops-k8s',
                name: 'DevOps K8s',
                pack: 'devops-k8s',
                summary: 'Container and Kubernetes delivery specialist.',
                tags: ['kubernetes', 'docker', 'deployment'],
                aliases: ['k8s', 'kubernetes', 'docker'],
                stack_signals: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'k8s/', 'helm/'],
                task_signals: ['deployment', 'rollout', 'container'],
                changed_path_signals: ['k8s/', 'helm/', 'deploy/', 'Dockerfile'],
                references: [],
                cost_hint: 'medium',
                priority: 85,
                autoload: 'suggest',
                deprecated: false,
                replaced_by: null,
                implemented: true,
                template_skill_path: 'template/skill-packs/devops-k8s/skills/devops-k8s/SKILL.md'
            }]
        }, null, 2),
        'utf8'
    );
    return path.join(skillRoot, 'SKILL.md');
}

function writeWorkflowConfig(repoRoot: string, payload: string): string {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, payload, 'utf8');
    return configPath;
}

function seedStrictProfileConfig(repoRoot: string): void {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'review-capabilities.json'), JSON.stringify({
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: true,
        test: true,
        performance: true,
        infra: true,
        dependency: true
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Balanced',
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
                review_finding_policy: {
                    schema_version: 1,
                    policy_id: 'balanced',
                    findings: {
                        critical: 'fix_now',
                        high: 'fix_now',
                        medium: 'create_follow_up',
                        low: 'create_follow_up'
                    },
                    residual_risk: 'create_follow_up'
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
            strict: {
                description: 'Strict',
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
                review_finding_policy: {
                    schema_version: 1,
                    policy_id: 'strict',
                    findings: {
                        critical: 'fix_now',
                        high: 'fix_now',
                        medium: 'fix_now',
                        low: 'fix_now'
                    },
                    residual_risk: 'fix_now'
                },
                token_economy: {
                    enabled: true,
                    strip_examples: false,
                    strip_code_blocks: false,
                    scoped_diffs: true,
                    compact_reviewer_output: false
                },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {}
    }, null, 2), 'utf8');
}

function seedSnapshotFreezeProfiles(repoRoot: string): string {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'review-capabilities.json'), JSON.stringify({
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: true,
        test: true,
        performance: true,
        infra: true,
        dependency: true
    }, null, 2), 'utf8');
    const profilesPath = path.join(configDir, 'profiles.json');
    fs.writeFileSync(profilesPath, JSON.stringify({
        version: 1,
        active_profile: 'lean',
        built_in_profiles: {
            lean: {
                description: 'Lean profile for snapshot freeze tests',
                depth: 2,
                review_policy: {
                    code: true,
                    db: 'auto',
                    security: 'auto',
                    refactor: 'auto',
                    api: 'auto',
                    test: 'auto',
                    performance: false,
                    infra: 'auto',
                    dependency: 'auto'
                },
                review_finding_policy: {
                    schema_version: 1,
                    policy_id: 'custom',
                    findings: {
                        critical: 'fix_now',
                        high: 'create_follow_up',
                        medium: 'ignore',
                        low: 'ignore'
                    },
                    residual_risk: 'ignore'
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
            strict: {
                description: 'Strict profile after task start',
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
                review_finding_policy: {
                    schema_version: 1,
                    policy_id: 'strict',
                    findings: {
                        critical: 'fix_now',
                        high: 'fix_now',
                        medium: 'fix_now',
                        low: 'fix_now'
                    },
                    residual_risk: 'fix_now'
                },
                token_economy: {
                    enabled: true,
                    strip_examples: false,
                    strip_code_blocks: false,
                    scoped_diffs: true,
                    compact_reviewer_output: false
                },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {}
    }, null, 2), 'utf8');
    return profilesPath;
}

function mutateActiveProfileToStrict(profilesPath: string): void {
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as Record<string, unknown>;
    profiles.active_profile = 'strict';
    const builtInProfiles = profiles.built_in_profiles as Record<string, Record<string, unknown>>;
    const leanProfile = builtInProfiles.lean;
    leanProfile.review_policy = {
        ...(leanProfile.review_policy as Record<string, unknown>),
        performance: true
    };
    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf8');
}

function writeSnapshotFreezeTriggerConfig(repoRoot: string): string {
    const pathsPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
    fs.writeFileSync(pathsPath, JSON.stringify({
        test_refactor_changed_lines_threshold: 7,
        triggers: {
            refactor: ['(^|/)src/special\\.ts$'],
            test: ['(^|/)quality/'],
            test_refactor_structural: ['(^|/)quality/helpers?/']
        }
    }, null, 2), 'utf8');
    return pathsPath;
}

function updateLatestTaskModeEventDetails(
    repoRoot: string,
    taskId: string,
    mutateDetails: (details: Record<string, unknown>) => void
): void {
    const eventsPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
    const timelineLines = fs.readFileSync(eventsPath, 'utf8').trimEnd().split('\n');
    let updated = false;
    for (let index = timelineLines.length - 1; index >= 0; index -= 1) {
        const event = JSON.parse(timelineLines[index]) as Record<string, unknown>;
        if (event.event_type !== 'TASK_MODE_ENTERED') {
            continue;
        }
        const details = event.details as Record<string, unknown>;
        mutateDetails(details);
        timelineLines[index] = JSON.stringify(event);
        updated = true;
        break;
    }
    assert.equal(updated, true, `Expected TASK_MODE_ENTERED event for ${taskId}`);
    let previousEventSha256: string | null = null;
    for (let index = 0; index < timelineLines.length; index += 1) {
        const event = JSON.parse(timelineLines[index]) as Record<string, unknown>;
        const integrity = event.integrity as Record<string, unknown>;
        integrity.prev_event_sha256 = previousEventSha256;
        delete integrity.event_sha256;
        const eventSha256 = buildEventIntegrityHash(event);
        assert.match(String(eventSha256 || ''), /^[a-f0-9]{64}$/u);
        integrity.event_sha256 = eventSha256;
        previousEventSha256 = eventSha256;
        timelineLines[index] = JSON.stringify(event);
    }
    fs.writeFileSync(eventsPath, `${timelineLines.join('\n')}\n`, 'utf8');
}

function appendPreflightClassifiedEvent(repoRoot: string, taskId: string, preflightPath: string): void {
    const normalizedPreflightPath = preflightPath.replace(/\\/g, '/');
    const existingEvents = readTaskTimelineEvents(repoRoot, taskId);
    const latestMatchingEvent = [...existingEvents].reverse().find((event) => (
        event.event_type === 'PREFLIGHT_CLASSIFIED'
        && String((event.details as Record<string, unknown> | undefined)?.output_path || '') === normalizedPreflightPath
    ));
    if (latestMatchingEvent) {
        return;
    }

    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : {};
    const mode = String(preflight.mode || 'FULL_PATH');
    const changedFilesCount = Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0;
    const changedLinesTotal = Number(metrics.changed_lines_total || 0);
    const zeroDiffGuard = preflight.zero_diff_guard && typeof preflight.zero_diff_guard === 'object' && !Array.isArray(preflight.zero_diff_guard)
        ? preflight.zero_diff_guard
        : (changedFilesCount === 0 && changedLinesTotal === 0
            ? { zero_diff_detected: true, status: 'BASELINE_ONLY' }
            : null);
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'PREFLIGHT_CLASSIFIED',
        'INFO',
        zeroDiffGuard
            ? `Preflight completed with mode ${mode} (zero-diff baseline only).`
            : `Preflight completed with mode ${mode}.`,
        {
            mode,
            output_path: normalizedPreflightPath,
            changed_files_count: changedFilesCount,
            changed_lines_total: changedLinesTotal,
            required_reviews: preflight.required_reviews || {},
            zero_diff_guard: zeroDiffGuard
        }
    );
}

function loadPostPreflightRulePack(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    ensurePreflightClassified = true,
    artifactPath = '',
    taskModePath = ''
) {
    if (ensurePreflightClassified) {
        appendPreflightClassifiedEvent(repoRoot, taskId, preflightPath);
    }
    return runLoadRulePackCommand({
        repoRoot,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
        artifactPath,
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '35-strict-coding-rules.md',
            '40-commands.md',
            '50-structure-and-docs.md',
            '70-security.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ],
        emitMetrics: false
    });
}

function writePreflight(
    repoRoot: string,
    taskId: string,
    overrides: Record<string, unknown> = {},
    outputFileName = `${taskId}-preflight.json`
): string {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, outputFileName);
    const payload = {
        task_id: taskId,
        detection_source: 'explicit_changed_files',
        mode: 'FULL_PATH',
        metrics: { changed_lines_total: 3 },
        required_reviews: {
            code: true,
            db: false,
            security: false,
            refactor: false,
            api: false,
            test: false,
            performance: false,
            infra: false,
            dependency: false
        },
        triggers: {},
        changed_files: ['src/app.ts'],
        ...overrides
    };
    fs.writeFileSync(preflightPath, JSON.stringify(payload, null, 2), 'utf8');
    return preflightPath;
}

function runExplicitPreflight(
    repoRoot: string,
    taskId: string,
    taskIntent: string,
    changedFiles: string[],
    outputFileName = `${taskId}-preflight.json`,
    taskModePath = ''
): string {
    const preflightPath = path.join(getReviewsRoot(repoRoot), outputFileName);
    const result = runClassifyChangeCommand({
        repoRoot,
        taskId,
        taskIntent,
        changedFiles,
        taskModePath,
        outputPath: preflightPath,
        emitMetrics: false
    });
    const payload = JSON.parse(result.outputText);
    assert.equal(payload.task_id, taskId);
    return preflightPath;
}

describe('cli/commands/gates — preflight', () => {
    it('classify-change uses legacy compatibility mode when workflow-config is missing', () => {
        const repoRoot = createTempRepo();
        try {
            const result = runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskIntent: 'Adjust workflow review ordering'
            });
            const parsed = JSON.parse(result.outputText) as Record<string, unknown>;
            assert.deepEqual(parsed.review_execution_policy, {
                mode: 'legacy_test_downstream',
                visible_summary_line: 'Review execution policy: legacy_test_downstream (implicit compatibility mode)'
            });
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classify-change fails closed when workflow-config is malformed', () => {
        const repoRoot = createTempRepo();
        try {
            writeWorkflowConfig(repoRoot, '{"full_suite_validation":');
            const error = captureExpectedError(() => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskIntent: 'Adjust workflow review ordering'
            }));
            assert.match(error.message, /workflow-config\.json/i);
            assert.match(error.message, /JSON/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classify-change fails closed when workflow-config uses a case-drifted review_execution_policy key', () => {
        const repoRoot = createTempRepo();
        try {
            writeWorkflowConfig(repoRoot, JSON.stringify({
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                Review_Execution_Policy: {
                    mode: 'parallel_all'
                }
            }, null, 2));
            const error = captureExpectedError(() => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskIntent: 'Adjust workflow review ordering'
            }));
            assert.match(error.message, /exact key 'review_execution_policy'/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classifies security file and emits risk_aware_depth with promoted effective depth', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const securityFilePath = path.join(repoRoot, 'src', 'auth', 'jwt-guard.ts');
        fs.mkdirSync(path.dirname(securityFilePath), { recursive: true });
        fs.writeFileSync(securityFilePath, 'export function verify() { return true; }\n', 'utf8');
        const outputPath = path.join(repoRoot, 'preflight-sec.json');
        seedTaskQueue(repoRoot, 'T-930');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-930',
            requestedDepth: 1,
            effectiveDepth: 1,
            taskSummary: 'Add JWT guard feature'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, 'T-930');
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-930');
        runShellSmokeForTask(repoRoot, 'T-930');
        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/auth/jwt-guard.ts'],
            taskId: 'T-930',
            taskIntent: 'Add JWT guard feature',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.triggers.security, true);
        assert.ok(payload.risk_aware_depth, 'risk_aware_depth should be present');
        assert.equal(payload.risk_aware_depth.effective_depth, 3, 'security trigger should promote to depth 3');
        assert.equal(payload.risk_aware_depth.escalated, true);
        assert.equal(payload.risk_aware_depth.compression.risk_level, 'high');
        assert.equal(payload.risk_aware_depth.compression.strip_examples, false);
        assert.equal(payload.risk_aware_depth.compression.strip_code_blocks, false);
        // Budget forecast should use the promoted depth
        assert.equal(payload.budget_forecast.effective_depth, 3);
        assert.equal(payload.budget_forecast.depth_escalated, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change emits task profile selection and keeps full-path safety floors for fast tasks', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        fs.writeFileSync(
            path.join(repoRoot, '.gitignore'),
            'TASK.md\ngarda-agent-orchestrator/runtime/\n',
            'utf8'
        );
        const testFilePath = path.join(repoRoot, 'tests', 'app.test.ts');
        fs.mkdirSync(path.dirname(testFilePath), { recursive: true });
        fs.writeFileSync(testFilePath, 'export const suite = true;\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'review-capabilities.json'), JSON.stringify({
            code: true,
            db: true,
            security: true,
            refactor: true,
            api: true,
            test: true,
            performance: true,
            infra: false,
            dependency: true
        }, null, 2));
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json'), JSON.stringify({
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Balanced',
                    depth: 2,
                    review_policy: { code: true, test: 'auto' },
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
                    description: 'Fast',
                    depth: 1,
                    review_policy: { code: true, test: 'auto' },
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: true,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        }, null, 2));
        const outputPath = path.join(repoRoot, 'preflight-fast-profile.json');
        seedTaskQueue(repoRoot, 'T-930-fast-profile', 'TODO', 'fast');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-930-fast-profile',
            requestedDepth: 1,
            effectiveDepth: 1,
            taskSummary: 'Honor fast task profile without bypassing full-path floors'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, 'T-930-fast-profile').exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-930-fast-profile');
        runShellSmokeForTask(repoRoot, 'T-930-fast-profile');

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts', 'tests/app.test.ts'],
            taskId: 'T-930-fast-profile',
            taskIntent: 'Honor fast task profile without bypassing full-path floors',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.profile_selection.task_profile, 'fast');
        assert.equal(payload.profile_selection.profile_selection_source, 'task_queue');
        assert.equal(payload.profile_selection.effective_profile, 'fast');
        assert.equal(payload.profile_selection.runtime_active_profile, 'balanced');
        assert.ok(payload.profile_guardrails, 'profile_guardrails should be present');
        assert.equal(payload.budget_forecast.requested_depth, 1);
        assert.equal(payload.budget_forecast.effective_depth, 2);
        assert.equal(payload.depth_escalation.escalated, true);
        assert.match(String(payload.depth_escalation.escalation_reason || ''), /full_path_minimum_depth_2/);
        assert.equal(payload.required_reviews.test, true);
        assert.equal(payload.required_reviews.api, false);
        assert.equal(payload.required_reviews.dependency, false);
        assert.equal(payload.required_reviews.security, false);
        assert.equal(payload.budget_forecast.token_economy_active_for_depth, true);

        seedTaskQueue(repoRoot, 'T-930-fast-docs-only', 'TODO', 'fast');
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-930-fast-docs-only',
            requestedDepth: 1,
            effectiveDepth: 1,
            taskSummary: 'Avoid reviewer launch for fast docs-only edits'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, 'T-930-fast-docs-only').exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-930-fast-docs-only');
        runShellSmokeForTask(repoRoot, 'T-930-fast-docs-only');

        const docsOnlyResult = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['docs/usage.md'],
            taskId: 'T-930-fast-docs-only',
            taskIntent: 'Avoid reviewer launch for fast docs-only edits',
            outputPath: path.join(repoRoot, 'preflight-fast-docs-only.json'),
            emitMetrics: false
        });

        const docsOnlyPayload = JSON.parse(docsOnlyResult.outputText);
        assert.equal(docsOnlyPayload.scope_category, 'docs-only');
        assert.equal(docsOnlyPayload.profile_selection.effective_profile, 'fast');
        assert.equal(docsOnlyPayload.required_reviews.code, false);
        assert.equal(
            docsOnlyPayload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'code')?.decision,
            'lightened_by_profile'
        );
        assert.equal(docsOnlyPayload.budget_forecast.required_reviews.includes('code'), false);

        seedTaskQueue(repoRoot, 'T-930-fast-docs-force-code', 'TODO', 'fast');
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-930-fast-docs-force-code',
            requestedDepth: 1,
            effectiveDepth: 1,
            taskSummary: 'Force code review for a fast docs-only edit'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, 'T-930-fast-docs-force-code').exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-930-fast-docs-force-code');
        runShellSmokeForTask(repoRoot, 'T-930-fast-docs-force-code');

        const forcedCodeResult = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['docs/usage.md'],
            taskId: 'T-930-fast-docs-force-code',
            taskIntent: 'Force code review for a fast docs-only edit',
            forceCodeReview: true,
            outputPath: path.join(repoRoot, 'preflight-fast-docs-force-code.json'),
            emitMetrics: false
        });

        const forcedCodePayload = JSON.parse(forcedCodeResult.outputText);
        assert.equal(forcedCodePayload.scope_category, 'docs-only');
        assert.equal(forcedCodePayload.required_reviews.code, true);
        assert.equal(
            forcedCodePayload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'code')?.decision,
            'profile_forced'
        );
        assert.equal(forcedCodePayload.budget_forecast.required_reviews.includes('code'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change retains task-mode profile policy snapshot after profiles config changes', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-profile-freeze';
        try {
            const profilesPath = seedSnapshotFreezeProfiles(repoRoot);
            const pathsPath = writeSnapshotFreezeTriggerConfig(repoRoot);
            seedTaskQueue(repoRoot, taskId, 'TODO', 'default');
            seedInitAnswers(repoRoot);
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Freeze profile policy at task mode entry',
                emitMetrics: false
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            mutateActiveProfileToStrict(profilesPath);
            fs.writeFileSync(pathsPath, JSON.stringify({
                test_refactor_changed_lines_threshold: 0,
                triggers: {
                    refactor: ['['],
                    test: ['(^|/)mutated-tests/'],
                    test_refactor_structural: ['(^|/)mutated-helpers/']
                }
            }, null, 2), 'utf8');

            const result = runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/special.ts'],
                taskId,
                taskIntent: 'Freeze profile policy at task mode entry',
                outputPath: path.join(repoRoot, 'preflight-profile-freeze.json'),
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText);

            assert.equal(payload.profile_selection.profile_selection_source, 'workspace_active');
            assert.equal(payload.profile_selection.effective_profile, 'lean');
            assert.equal(payload.profile_selection.runtime_active_profile, 'lean');
            assert.equal(payload.required_reviews.performance, false);
            assert.equal(payload.required_reviews.refactor, true);
            assert.equal(payload.triggers.refactor_path, true);
            assert.deepEqual(payload.triggers.refactor_path_changed_files, ['src/special.ts']);
            assert.equal(payload.metrics.classification_config_source, 'task_profile_policy_snapshot');
            assert.equal(payload.profile_policy_snapshot.source.effective_profile, 'lean');
            assert.match(payload.profile_policy_snapshot.snapshot_hash, /^[a-f0-9]{64}$/);
            assert.equal(
                payload.review_execution_policy.mode,
                payload.profile_policy_snapshot.review_execution_policy.mode
            );
            assert.equal(
                payload.review_execution_policy.visible_summary_line,
                payload.profile_policy_snapshot.review_execution_policy.visible_summary_line
            );
            assert.equal(payload.profile_policy_snapshot.review_lane_selection.effective_review_policy.security, true);
            assert.equal(payload.profile_policy_snapshot.review_lane_selection.effective_review_policy.performance, false);
            assert.deepEqual(payload.profile_policy_snapshot.review_lane_selection.safety_floors_applied, []);
            assert.equal(payload.profile_policy_snapshot.review_finding_policy.policy_id, 'custom');
            assert.equal(payload.profile_policy_snapshot.review_finding_policy.findings.critical, 'fix_now');
            assert.equal(payload.profile_policy_snapshot.review_finding_policy.findings.high, 'create_follow_up');
            assert.equal(payload.profile_policy_snapshot.review_finding_policy.residual_risk, 'ignore');
            assert.equal(payload.profile_policy_snapshot.finding_policy.policy_id, 'profile_review_finding_dispositions_v1');
            assert.equal(payload.profile_policy_snapshot.finding_policy.active_findings.critical, 'block_until_resolved');
            assert.equal(payload.profile_policy_snapshot.finding_policy.active_findings.high, 'create_follow_up');
            assert.equal(payload.profile_policy_snapshot.finding_policy.active_findings.medium, 'ignore');
            assert.equal(payload.profile_policy_snapshot.finding_policy.residual_risks, 'ignore');
            assert.equal(payload.profile_policy_snapshot.remediation_policy.review_restarts_retain_profile_snapshot, true);
            assert.deepEqual(payload.profile_policy_snapshot.review_trigger_policy, {
                schema_version: 1,
                refactor_path_regexes: ['(^|/)src/special\\.ts$'],
                test_path_regexes: ['(^|/)quality/'],
                test_refactor_structural_path_regexes: ['(^|/)quality/helpers?/'],
                test_refactor_changed_lines_threshold: 7
            });
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('freezes explicit follow-up task closure policy across completed-task re-entry and preflight evidence', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const parentTaskId = 'T-979';
        const taskId = `${parentTaskId}-F1`;
        try {
            const profilesPath = seedSnapshotFreezeProfiles(repoRoot);
            writeSnapshotFreezeTriggerConfig(repoRoot);
            const seedFollowUpTaskQueue = (status: string, profile: string, childNotes: string): void => {
                const parentNotes = `Review follow-up tasks materialized: \`${taskId}\`; artifact `
                    + `\`garda-agent-orchestrator/runtime/reviews/${parentTaskId}-review-follow-up-tasks.json\`.`;
                fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
                    '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                    `| ${parentTaskId} | DONE | P1 | test | Parent review task | unassigned | 2026-03-28 | default | ${parentNotes} |`,
                    `| ${taskId} | ${status} | P1 | test | Follow-up review task | unassigned | 2026-03-28 | ${profile} | ${childNotes} |`
                ].join('\n'), 'utf8');
            };
            const notes = [
                `Child of \`${parentTaskId}\`.`,
                `review_follow_up_group_fingerprint=${'d'.repeat(64)}.`,
                formatReviewFollowUpTaskClosurePolicyMetadata({
                    skip_low_findings: true,
                    forbid_child_tasks: false
                })
            ].join(' ');
            seedFollowUpTaskQueue('TODO', 'default', notes);
            seedInitAnswers(repoRoot);

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Freeze explicit follow-up task closure policy',
                emitMetrics: false
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
            const taskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
            const taskModeSnapshot = taskMode.profile_policy_snapshot as TaskProfilePolicySnapshot;
            assert.deepEqual(taskModeSnapshot.review_follow_up_task_closure_policy, {
                schema_version: 1,
                eligible: true,
                configured: true,
                valid: true,
                provenance: 'grouped_by_parent',
                source_notes_sha256: createHash('sha256').update(notes, 'utf8').digest('hex'),
                skip_low_findings: true,
                forbid_child_tasks: false,
                diagnostics: [
                    'Review follow-up task closure policy resolved from explicit grouped_by_parent task metadata.'
                ]
            });

            mutateActiveProfileToStrict(profilesPath);
            const driftedNotes = [
                `Child of \`${parentTaskId}\`.`,
                `review_follow_up_group_fingerprint=${'e'.repeat(64)}.`,
                formatReviewFollowUpTaskClosurePolicyMetadata({
                    skip_low_findings: false,
                    forbid_child_tasks: true
                })
            ].join(' ');
            seedFollowUpTaskQueue('DONE', 'strict', driftedNotes);
            initializeGitRepo(repoRoot);

            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Re-enter completed task without mutating frozen follow-up closure policy',
                emitMetrics: false
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            const reenteredTaskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
            const reenteredTaskModeSnapshot = reenteredTaskMode.profile_policy_snapshot as TaskProfilePolicySnapshot;
            assert.deepEqual(reenteredTaskModeSnapshot, taskModeSnapshot);

            const result = runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/special.ts'],
                taskId,
                taskIntent: 'Freeze explicit follow-up task closure policy',
                outputPath: path.join(repoRoot, 'preflight-follow-up-closure-policy.json'),
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText) as Record<string, unknown>;
            const preflightSnapshot = payload.profile_policy_snapshot as Record<string, unknown>;

            assert.deepEqual(
                preflightSnapshot.review_follow_up_task_closure_policy,
                taskModeSnapshot.review_follow_up_task_closure_policy
            );
            assert.equal(preflightSnapshot.snapshot_hash, taskModeSnapshot.snapshot_hash);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classify-change fails closed when the task profile policy snapshot is mutated', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-profile-snapshot-tamper';
        try {
            seedSnapshotFreezeProfiles(repoRoot);
            seedTaskQueue(repoRoot, taskId, 'TODO', 'default');
            seedInitAnswers(repoRoot);
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject mutable profile policy snapshot evidence',
                emitMetrics: false
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
            const artifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
            const snapshot = artifact.profile_policy_snapshot as Record<string, unknown>;
            const source = snapshot.source as Record<string, unknown>;
            source.effective_profile = 'strict';
            fs.writeFileSync(taskModePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

            const error = captureExpectedError(() => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskId,
                taskIntent: 'Reject mutable profile policy snapshot evidence',
                outputPath: path.join(repoRoot, 'preflight-profile-snapshot-tamper.json'),
                emitMetrics: false
            }));
            assert.match(error.message, /profile policy snapshot/i);
            assert.match(error.message, /hash mismatch/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classify-change fails closed when task-mode profile policy semantics are forged with a recomputed snapshot hash', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-profile-snapshot-policy-forged';
        try {
            seedSnapshotFreezeProfiles(repoRoot);
            seedTaskQueue(repoRoot, taskId, 'TODO', 'default');
            seedInitAnswers(repoRoot);
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject forged profile policy snapshot semantics',
                emitMetrics: false
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
            const artifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
            const snapshot = artifact.profile_policy_snapshot as TaskProfilePolicySnapshot;
            snapshot.finding_policy.active_findings.medium = 'allow_without_resolution' as 'block_until_resolved';
            (snapshot.review_finding_policy.findings as unknown as Record<string, string>).critical = 'ignore';
            snapshot.remediation_policy.active_findings_require_fix_before_pass = false as true;
            snapshot.snapshot_hash = computeTaskProfilePolicySnapshotHash(snapshot);
            updateLatestTaskModeEventDetails(repoRoot, taskId, (details) => {
                details.profile_policy_snapshot_hash = snapshot.snapshot_hash;
            });
            fs.writeFileSync(taskModePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

            const error = captureExpectedError(() => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskId,
                taskIntent: 'Reject forged profile policy snapshot semantics',
                outputPath: path.join(repoRoot, 'preflight-profile-snapshot-policy-forged.json'),
                emitMetrics: false
            }));
            assert.match(error.message, /profile policy snapshot/i);
            assert.match(error.message, /finding_policy\.active_findings\.medium/i);
            assert.match(error.message, /review_finding_policy\.findings\.critical/i);
            assert.match(error.message, /remediation_policy\.active_findings_require_fix_before_pass/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classify-change fails closed when task-mode evidence omits the profile policy snapshot', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-profile-snapshot-missing';
        try {
            const profilesPath = seedSnapshotFreezeProfiles(repoRoot);
            seedTaskQueue(repoRoot, taskId, 'TODO', 'default');
            seedInitAnswers(repoRoot);
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject missing profile policy snapshot evidence',
                emitMetrics: false
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
            const artifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
            artifact.profile_policy_snapshot_required = false;
            delete artifact.profile_policy_snapshot;
            fs.writeFileSync(taskModePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

            updateLatestTaskModeEventDetails(repoRoot, taskId, (details) => {
                delete details.profile_policy_snapshot_required;
                delete details.profile_policy_snapshot_hash;
                delete details.profile_policy_snapshot_config_hash;
            });
            mutateActiveProfileToStrict(profilesPath);

            const error = captureExpectedError(() => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskId,
                taskIntent: 'Reject missing profile policy snapshot evidence',
                outputPath: path.join(repoRoot, 'preflight-profile-snapshot-missing.json'),
                emitMetrics: false
            }));
            assert.match(error.message, /profile policy snapshot is required/i);
            assert.match(error.message, /missing/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classify-change fails closed when the task-mode timeline omits the profile policy snapshot hash', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-profile-snapshot-timeline-hash-missing';
        try {
            seedSnapshotFreezeProfiles(repoRoot);
            seedTaskQueue(repoRoot, taskId, 'TODO', 'default');
            seedInitAnswers(repoRoot);
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject unbound profile policy snapshot evidence',
                emitMetrics: false
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            updateLatestTaskModeEventDetails(repoRoot, taskId, (details) => {
                delete details.profile_policy_snapshot_hash;
            });

            const error = captureExpectedError(() => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskId,
                taskIntent: 'Reject unbound profile policy snapshot evidence',
                outputPath: path.join(repoRoot, 'preflight-profile-snapshot-timeline-hash-missing.json'),
                emitMetrics: false
            }));
            assert.match(error.message, /profile policy snapshot/i);
            assert.match(error.message, /timeline/i);
            assert.match(error.message, /profile_policy_snapshot_hash is missing/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classify-change fails closed when the task profile policy snapshot is stale against timeline', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-profile-snapshot-stale';
        try {
            seedSnapshotFreezeProfiles(repoRoot);
            seedTaskQueue(repoRoot, taskId, 'TODO', 'default');
            seedInitAnswers(repoRoot);
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject stale profile policy snapshot evidence',
                emitMetrics: false
            });
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            updateLatestTaskModeEventDetails(repoRoot, taskId, (details) => {
                details.profile_policy_snapshot_hash = '0'.repeat(64);
            });

            const error = captureExpectedError(() => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskId,
                taskIntent: 'Reject stale profile policy snapshot evidence',
                outputPath: path.join(repoRoot, 'preflight-profile-snapshot-stale.json'),
                emitMetrics: false
            }));
            assert.match(error.message, /profile policy snapshot/i);
            assert.match(error.message, /stale|does not match/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classify-change strict profile does not force DB review without DB surface evidence', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-no-db-surface.json');
        const taskId = 'T-930-strict-no-db-surface';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Keep strict reviews domain-aware without forcing DB in a no-database project'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Keep strict reviews domain-aware without forcing DB in a no-database project',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.profile_selection.effective_profile, 'strict');
        assert.equal(payload.triggers.db, false);
        assert.deepEqual(payload.triggers.db_project_evidence, []);
        assert.equal(payload.required_reviews.code, true);
        assert.equal(payload.required_reviews.security, true);
        assert.equal(payload.required_reviews.refactor, false);
        assert.equal(payload.required_reviews.test, true);
        assert.equal(payload.required_reviews.db, false);
        assert.equal(payload.required_reviews.api, false);
        assert.equal(payload.required_reviews.performance, true);
        assert.equal(payload.required_reviews.dependency, false);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'db')?.decision,
            'not_applicable_no_domain_surface'
        );
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'api')?.decision,
            'not_applicable_no_domain_surface'
        );
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'dependency')?.decision,
            'not_applicable_no_domain_surface'
        );
        assert.deepEqual(payload.budget_forecast.required_reviews.includes('db'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile keeps true docs-only scopes on applicable reviews only', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-docs-only.json');
        const taskId = 'T-930-strict-docs-only';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Keep strict profile docs-only updates lightweight'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['docs/usage.md'],
            taskId,
            taskIntent: 'Keep strict profile docs-only updates lightweight',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.scope_category, 'docs-only');
        assert.equal(payload.profile_selection.effective_profile, 'strict');
        assert.equal(payload.required_reviews.code, false);
        assert.equal(payload.required_reviews.security, false);
        assert.equal(payload.required_reviews.refactor, false);
        assert.equal(payload.required_reviews.test, false);
        for (const reviewType of ['code', 'security']) {
            const decision = payload.profile_guardrails.decisions.find(
                (entry: Record<string, unknown>) => entry.review_type === reviewType
            );
            assert.equal(decision?.decision, 'lightened_by_profile');
            assert.match(String(decision?.reason || ''), /docs-only/);
        }
        assert.equal(
            payload.profile_guardrails.decisions.find((entry: Record<string, unknown>) => entry.review_type === 'refactor')?.decision,
            'not_applicable_no_domain_surface'
        );
        assert.deepEqual(payload.budget_forecast.required_reviews, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile keeps localization-only scopes out of review and budget pressure', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-localization-only.json');
        const taskId = 'T-930-strict-localization-only';
        const localizationFiles = [
            'src/reports/ui/lang-packs/garda-ui-ru.json',
            'src/reports/ui/workflow-setting-text/en-reference.json',
            'src/reports/ui/workflow-setting-text/lang/de.json'
        ];
        for (const filePath of localizationFiles) {
            const absolutePath = path.join(repoRoot, filePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(
                absolutePath,
                JSON.stringify({ label: `translated ${filePath}` }, null, 2) + '\n',
                'utf8'
            );
        }
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 3,
            effectiveDepth: 3,
            taskSummary: 'Update local UI translations only'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: localizationFiles,
            taskId,
            taskIntent: 'Update local UI translations only',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.scope_category, 'config-only');
        assert.equal(payload.profile_selection.effective_profile, 'strict');
        assert.equal(payload.triggers.ui_i18n_companion_scope, false);
        assert.equal(payload.triggers.ui_i18n_review_trigger_suppressed, true);
        assert.deepEqual(payload.triggers.ui_i18n_review_trigger_files, []);
        assert.deepEqual(payload.changed_files, localizationFiles);
        for (const reviewType of ['code', 'security', 'refactor', 'api', 'test', 'performance', 'infra', 'dependency']) {
            assert.equal(payload.required_reviews[reviewType], false, `${reviewType} should not be required`);
        }
        for (const reviewType of ['code', 'security', 'refactor']) {
            const decision = payload.profile_guardrails.decisions.find(
                (entry: Record<string, unknown>) => entry.review_type === reviewType
            );
            assert.equal(decision?.decision, 'lightened_by_profile');
            assert.match(String(decision?.reason || ''), /localization-only/);
        }
        assert.equal(payload.metrics.changed_files_count, localizationFiles.length);
        assert.equal(payload.metrics.review_trigger_effective_changed_files_count, 0);
        assert.equal(payload.budget_forecast.changed_files_count, 0);
        assert.equal(payload.budget_forecast.changed_lines_total, 0);
        assert.deepEqual(payload.budget_forecast.required_reviews, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile keeps mixed docs plus code on full review path', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-docs-code.json');
        const taskId = 'T-930-strict-docs-code';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Keep mixed docs plus code updates on full validation path'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['docs/usage.md', 'src/app.ts'],
            taskId,
            taskIntent: 'Keep mixed docs plus code updates on full validation path',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.scope_category, 'mixed');
        assert.equal(payload.profile_selection.effective_profile, 'strict');
        assert.equal(payload.required_reviews.code, true);
        assert.equal(payload.required_reviews.security, true);
        assert.equal(payload.required_reviews.refactor, false);
        assert.equal(payload.required_reviews.test, true);
        assert.equal(payload.required_reviews.performance, true);
        assert.ok(payload.budget_forecast.required_reviews.includes('code'));
        assert.ok(payload.budget_forecast.required_reviews.includes('security'));
        assert.equal(payload.budget_forecast.required_reviews.includes('refactor'), false);
        assert.ok(payload.budget_forecast.required_reviews.includes('test'));
        assert.ok(payload.budget_forecast.required_reviews.includes('performance'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile treats pure test-scope diffs as test-review-only', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-test-only.json');
        const taskId = 'T-930-strict-test-only';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Keep strict profile test fixture changes on test review only'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['tests/node/cli/commands/gates-review-reuse-stale-evidence.test.ts'],
            taskId,
            taskIntent: 'Keep strict profile test fixture changes on test review only',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.scope_category, 'test-only');
        assert.equal(payload.profile_selection.effective_profile, 'strict');
        assert.equal(payload.triggers.test, true);
        assert.equal(payload.required_reviews.code, false);
        assert.equal(payload.required_reviews.security, false);
        assert.equal(payload.required_reviews.refactor, false);
        assert.equal(payload.required_reviews.test, true);
        for (const reviewType of ['code', 'security', 'refactor']) {
            const decision = payload.profile_guardrails.decisions.find(
                (entry: Record<string, unknown>) => entry.review_type === reviewType
            );
            assert.equal(decision?.decision, 'lightened_by_profile');
            assert.match(String(decision?.reason || ''), /test-only/);
        }
        assert.deepEqual(payload.budget_forecast.required_reviews, ['test']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change keeps profile diagnostics aligned when test-only refactor intent requires refactor review', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-test-only-refactor-intent.json');
        const taskId = 'T-930-strict-test-only-refactor-intent';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        const taskSummary = 'Refactor review parity diagnostics for test fixture changes';
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['tests/node/cli/commands/gates-review-reuse-stale-evidence.test.ts'],
            taskId,
            taskIntent: taskSummary,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.scope_category, 'test-only');
        assert.equal(payload.triggers.refactor_intent, true);
        assert.equal(payload.required_reviews.refactor, true);
        assert.equal(payload.required_reviews.test, true);
        const refactorDecision = payload.profile_guardrails.decisions.find(
            (entry: Record<string, unknown>) => entry.review_type === 'refactor'
        );
        assert.equal(refactorDecision?.effective_value, true);
        assert.equal(refactorDecision?.decision, 'preflight_required');
        assert.match(String(refactorDecision?.reason || ''), /required_reviews\.refactor=true/);
        assert.deepEqual(payload.budget_forecast.required_reviews, ['refactor', 'test']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change keeps raw profile diagnostics aligned when preflight suppresses capability defaults', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-balanced-required-review-parity.json');
        const taskId = 'T-930-balanced-review-parity';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'balanced');
        seedInitAnswers(repoRoot);
        const taskSummary = 'Align profile guardrail diagnostics with enforced required reviews';
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts', 'tests/app.test.ts'],
            taskId,
            taskIntent: taskSummary,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.profile_selection.effective_profile, 'balanced');
        assert.equal(payload.required_reviews.code, true);
        assert.equal(payload.required_reviews.test, true);
        assert.equal(payload.required_reviews.security, false);
        assert.equal(payload.required_reviews.refactor, false);
        const byReviewType = new Map(
            payload.profile_guardrails.decisions.map((decision: Record<string, unknown>) => [decision.review_type, decision])
        );
        for (const reviewType of ['security', 'refactor']) {
            const decision = byReviewType.get(reviewType) as Record<string, unknown> | undefined;
            assert.equal(decision?.effective_value, false);
            assert.equal(decision?.decision, 'not_applicable_no_domain_surface');
            assert.match(String(decision?.reason || ''), /no .* trigger or project surface evidence/);
        }
        assert.equal((byReviewType.get('code') as Record<string, unknown> | undefined)?.effective_value, true);
        assert.equal((byReviewType.get('test') as Record<string, unknown> | undefined)?.effective_value, true);
        assert.deepEqual(payload.budget_forecast.required_reviews, ['code', 'test']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change ignores generated runtime artifacts for test-only review routing', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-generated-runtime-artifacts.json');
        const taskId = 'T-930-generated-runtime-artifacts';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Ignore generated runtime artifacts during preflight scope classification'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: [
                'tests/node/cli/commands/gates-preflight.test.ts',
                'garda-agent-orchestrator/runtime/reports/garda-report.html',
                'garda-agent-orchestrator/runtime/task-events/T-930-generated-runtime-artifacts.jsonl',
                'Z:/missing/root/runtime/task-events/all-tasks.jsonl',
                'mnt/wsl/projects/missing/runtime/task-events/T-930-generated-runtime-artifacts.jsonl'
            ],
            taskId,
            taskIntent: 'Ignore generated runtime artifacts during preflight scope classification',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.deepEqual(payload.changed_files, ['tests/node/cli/commands/gates-preflight.test.ts']);
        assert.equal(payload.scope_category, 'test-only');
        assert.equal(payload.metrics.changed_files_count, 1);
        assert.equal(payload.metrics.ignored_generated_runtime_files_count, 4);
        assert.deepEqual(payload.triggers.ignored_generated_runtime_files, [
            'Z:/missing/root/runtime/task-events/all-tasks.jsonl',
            'garda-agent-orchestrator/runtime/reports/garda-report.html',
            'garda-agent-orchestrator/runtime/task-events/T-930-generated-runtime-artifacts.jsonl',
            'mnt/wsl/projects/missing/runtime/task-events/T-930-generated-runtime-artifacts.jsonl'
        ]);
        assert.equal(payload.required_reviews.code, false);
        assert.equal(payload.required_reviews.security, false);
        assert.equal(payload.required_reviews.refactor, false);
        assert.equal(payload.required_reviews.test, true);
        assert.deepEqual(payload.budget_forecast.required_reviews, ['test']);
        assert.match(payload.workspace_hygiene_warnings[0], /Ignored 4 generated runtime\/control-plane artifact/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change keeps code-like protected control-plane files in implementation domain fingerprints', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-domain-scope-protected-code.json');
        const taskId = 'T-930-domain-scope-protected-code';
        seedStrictProfileConfig(repoRoot);
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.orchestrator_work_policy = {
            mode: 'require_operator_confirmation'
        };
        writeWorkflowConfig(repoRoot, `${JSON.stringify(workflowConfig, null, 2)}\n`);
        seedTaskQueue(
            repoRoot,
            taskId,
            'TODO',
            'strict',
            'workflow-config policy changes'
        );
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Keep protected control-plane TypeScript in implementation domain fingerprints',
            orchestratorWork: true,
            workflowConfigWork: true,
            operatorConfirmed: 'yes',
            operatorConfirmedAtUtc: new Date().toISOString(),
            plannedChangedFiles: [
                'src/gates/review-tree-state.ts',
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: [
                'src/gates/review-tree-state.ts',
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ],
            taskId,
            taskIntent: 'Keep protected control-plane TypeScript in implementation domain fingerprints',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        const domainFingerprints = payload.metrics.domain_scope_fingerprints;
        assert.deepEqual(domainFingerprints.domains.implementation.changed_files, ['src/gates/review-tree-state.ts']);
        assert.deepEqual(
            domainFingerprints.domains.config.changed_files,
            ['garda-agent-orchestrator/live/config/workflow-config.json']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile suppresses reviews for audited zero-diff baseline-only closeout', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-zero-diff.json');
        const taskId = 'T-930-strict-zero-diff';
        seedStrictProfileConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Close out reviewer trust validation with no additional file changes'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Close out reviewer trust validation with no additional file changes',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.scope_category, 'empty');
        assert.equal(payload.metrics.changed_files_count, 0);
        assert.equal(payload.zero_diff_guard.status, 'BASELINE_ONLY');
        assert.equal(payload.zero_diff_guard.completion_requires_audited_no_op, true);
        assert.equal(payload.profile_guardrails.zero_diff_no_reviewable_scope, true);
        assert.equal(payload.required_reviews.code, false);
        assert.equal(payload.required_reviews.security, false);
        assert.equal(payload.required_reviews.refactor, false);
        assert.equal(payload.required_reviews.db, false);
        assert.equal(payload.budget_forecast.required_reviews.length, 0);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'code')?.decision,
            'zero_diff_no_reviewable_scope'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change suppresses intent-only refactor reviews for git-auto zero-diff baseline-only closeout', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-zero-diff-refactor-intent.json');
        const taskId = 'T-930-zero-diff-refactor-intent';
        seedStrictProfileConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        const taskSummary = 'Finish refactor protected-manifest and completion regression fixture cleanup from checkpoint';
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: taskSummary,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.detection_source, 'git_auto');
        assert.equal(payload.scope_category, 'empty');
        assert.equal(payload.metrics.changed_files_count, 0);
        assert.equal(payload.triggers.refactor_intent, false);
        assert.equal(payload.zero_diff_guard.status, 'BASELINE_ONLY');
        assert.equal(payload.profile_guardrails.zero_diff_no_reviewable_scope, true);
        assert.equal(payload.required_reviews.code, false);
        assert.equal(payload.required_reviews.refactor, false);
        assert.equal(payload.budget_forecast.required_reviews.length, 0);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'refactor')?.decision,
            'zero_diff_no_reviewable_scope'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile keeps reviews for zero-diff with planned task scope', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-zero-diff-planned.json');
        const taskId = 'T-930-strict-zero-diff-planned';
        seedStrictProfileConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Plan a source change before implementation',
            plannedChangedFiles: ['src/app.ts']
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Plan a source change before implementation',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.scope_category, 'empty');
        assert.equal(payload.zero_diff_guard.status, 'BASELINE_ONLY');
        assert.equal(payload.profile_guardrails.zero_diff_no_reviewable_scope, false);
        assert.equal(payload.required_reviews.code, true);
        assert.equal(payload.budget_forecast.required_reviews.includes('code'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile keeps reviews for explicit empty scoped preflight', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-explicit-empty.json');
        const taskId = 'T-930-strict-explicit-empty';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Attempt an explicit empty scoped preflight'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: [],
            taskId,
            taskIntent: 'Attempt an explicit empty scoped preflight',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.detection_source, 'explicit_changed_files');
        assert.equal(payload.scope_category, 'empty');
        assert.equal(payload.zero_diff_guard.status, 'BASELINE_ONLY');
        assert.equal(payload.profile_guardrails.zero_diff_no_reviewable_scope, false);
        assert.equal(payload.required_reviews.code, true);
        assert.equal(payload.budget_forecast.required_reviews.includes('code'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile keeps DB review when DB surface evidence is present', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const migrationPath = path.join(repoRoot, 'src', 'db', 'migrations', '001_init.sql');
        fs.mkdirSync(path.dirname(migrationPath), { recursive: true });
        fs.writeFileSync(migrationPath, 'create table users (id text primary key);\n', 'utf8');
        const outputPath = path.join(repoRoot, 'preflight-strict-db-surface.json');
        const taskId = 'T-930-strict-db-surface';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Keep strict DB review when database migration scope exists'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/db/migrations/001_init.sql'],
            taskId,
            taskIntent: 'Keep strict DB review when database migration scope exists',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.triggers.db, true);
        assert.equal(payload.required_reviews.db, true);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'db')?.decision,
            'domain_triggered'
        );
        assert.equal(payload.budget_forecast.required_reviews.includes('db'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile downgrades DB review when only project DB evidence exists', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
            dependencies: {
                pg: '^8.0.0'
            }
        }, null, 2), 'utf8');
        const outputPath = path.join(repoRoot, 'preflight-strict-db-project-evidence.json');
        const taskId = 'T-930-strict-db-project-evidence';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Downgrade strict DB review when only project database capability exists'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Keep strict DB review when project database capability exists',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.triggers.db, false);
        assert.ok(payload.triggers.db_project_evidence.includes('package:pg'));
        assert.equal(payload.triggers.db_downgrade_reason, 'project_db_evidence_without_db_changed_scope');
        assert.equal(payload.required_reviews.db, false);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'db')?.decision,
            'not_applicable_no_domain_surface'
        );
        assert.equal(payload.budget_forecast.required_reviews.includes('db'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile supports explicit all-domain review override', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-force-domain.json');
        const taskId = 'T-930-strict-force-domain';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Force all strict domain reviews for an audited override'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Force all strict domain reviews for an audited override',
            forceAllDomainReviews: true,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.triggers.db, false);
        assert.equal(payload.required_reviews.db, true);
        assert.equal(payload.required_reviews.api, true);
        assert.equal(payload.required_reviews.performance, true);
        assert.equal(payload.required_reviews.dependency, true);
        assert.equal(payload.required_reviews.infra, true);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'db')?.decision,
            'profile_forced'
        );
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'api')?.decision,
            'profile_forced'
        );
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'dependency')?.decision,
            'profile_forced'
        );
        assert.equal(payload.budget_forecast.required_reviews.includes('db'), true);
        assert.equal(payload.budget_forecast.required_reviews.includes('api'), true);
        assert.equal(payload.budget_forecast.required_reviews.includes('dependency'), true);
        assert.equal(payload.budget_forecast.required_reviews.includes('infra'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change public CLI parses explicit all-domain review override', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-force-domain-cli.json');
        const taskId = 'T-930-strict-force-domain-cli';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Force all strict domain reviews through the public CLI flag'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = await runCliWithCapturedOutput([
            'gate',
            'classify-change',
            '--task-id', taskId,
            '--task-intent', 'Force all strict domain reviews through the public CLI flag',
            '--changed-file', 'src/app.ts',
            '--force-all-domain-reviews',
            '--output-path', outputPath,
            '--repo-root', repoRoot
        ], { cwd: repoRoot });

        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.errors, []);
        assert.equal(fs.existsSync(outputPath), true);
        const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        assert.equal(payload.triggers.db, false);
        assert.equal(payload.required_reviews.db, true);
        assert.equal(payload.required_reviews.api, true);
        assert.equal(payload.required_reviews.performance, true);
        assert.equal(payload.required_reviews.dependency, true);
        assert.equal(payload.required_reviews.infra, true);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'db')?.decision,
            'profile_forced'
        );
        assert.equal(payload.budget_forecast.required_reviews.includes('db'), true);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change with task-id auto-materializes the canonical preflight path', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-930-default-preflight-path';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Auto materialize default preflight artifact path'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            changedFiles: ['src/app.ts'],
            taskIntent: 'Auto materialize default preflight artifact path',
            emitMetrics: false
        });

        const canonicalPreflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.equal(fs.existsSync(canonicalPreflightPath), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(canonicalPreflightPath, 'utf8')), payload);

        const preflightEvent = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => event.event_type === 'PREFLIGHT_CLASSIFIED');
        assert.ok(preflightEvent, 'expected PREFLIGHT_CLASSIFIED event');
        assert.equal(
            String((preflightEvent.details as Record<string, unknown>).output_path || ''),
            canonicalPreflightPath.replace(/\\/g, '/')
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change uses the explicit custom task-mode artifact path for requested depth and budget forecasting', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-custom-task-mode-depth.json');
        const taskId = 'T-930-custom-task-mode-depth';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 3,
            effectiveDepth: 3,
            taskSummary: 'Preserve requested depth from a custom task-mode artifact path',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Preserve requested depth from a custom task-mode artifact path',
            taskModePath: customTaskModePath,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.equal(payload.risk_aware_depth.requested_depth, 3);
        assert.equal(payload.risk_aware_depth.effective_depth, 3);
        assert.equal(payload.risk_aware_depth.escalated, false);
        assert.equal(payload.budget_forecast.requested_depth, 3);
        assert.equal(payload.budget_forecast.effective_depth, 3);
        assert.equal(payload.budget_forecast.depth_escalated, false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change accepts a legacy handshake artifact when the corroborating task-mode evidence is on a custom path', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-custom-task-mode-legacy-handshake.json');
        const taskId = 'T-930-custom-task-mode-legacy-handshake';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Honor a custom task-mode path when legacy handshake launchability must be corroborated.',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);

        writeHandshakeArtifact(repoRoot, taskId, 'Codex');
        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        const handshakePath = path.join(getReviewsRoot(repoRoot), `${taskId}-handshake.json`);
        const handshakeArtifact = JSON.parse(fs.readFileSync(handshakePath, 'utf8')) as Record<string, unknown>;
        delete handshakeArtifact.reviewer_subagent_launch_status;
        delete handshakeArtifact.reviewer_subagent_launch_route;
        const handshakeContent = JSON.stringify(handshakeArtifact, null, 2);
        fs.writeFileSync(handshakePath, handshakeContent, 'utf8');
        const handshakeHash = createHash('sha256').update(handshakeContent).digest('hex');
        appendTaskEvent(
            orchestratorRoot,
            taskId,
            'HANDSHAKE_DIAGNOSTICS_RECORDED',
            'PASS',
            'Legacy handshake diagnostics recorded for custom task-mode path compatibility coverage.',
            {
                provider: 'Codex',
                execution_provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                execution_provider_source: 'provider_entrypoint',
                execution_context: 'materialized-bundle',
                cli_path: 'node garda-agent-orchestrator/bin/garda.js',
                passed: true,
                artifact_hash: handshakeHash
            },
            { actor: 'gate', passThru: true }
        );
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Honor a custom task-mode path when legacy handshake launchability must be corroborated.',
            taskModePath: customTaskModePath,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.equal(payload.required_reviews.code, true);
        assert.equal(fs.existsSync(outputPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classifies explicit changed files and writes preflight artifact', () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight.json');
        seedTaskQueue(repoRoot, 'T-900');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-900',
            taskSummary: 'Update app flow'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, 'T-900');
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-900');
        runShellSmokeForTask(repoRoot, 'T-900');
        fs.mkdirSync(path.join(getOrchestratorRoot(repoRoot), 'live', 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'garda.config.json'),
            JSON.stringify({ version: 1, configs: { 'optional-skill-selection-policy': 'optional-skill-selection-policy.json' } }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
            'utf8'
        );
        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId: 'T-900',
            taskIntent: 'Update app flow',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, 'T-900');
        assert.equal(payload.changed_files[0], 'src/app.ts');
        assert.equal(payload.required_reviews.code, true);
        assert.equal(fs.existsSync(outputPath), true);
        const persistedPayload = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
        assert.ok(persistedPayload.optional_skill_selection);
        assert.equal(
            (persistedPayload.optional_skill_selection as Record<string, unknown>).artifact_path,
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-900-optional-skill-selection.json').replace(/\\/g, '/')
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change selects mandatory installed devops skill from project discovery surface', () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-devops.json');
        const taskId = 'T-909-devops-parity';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Tune JVM heap without changing deployment manifests'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        seedDevopsOptionalSkillFixture(repoRoot, 'required');
        fs.writeFileSync(
            path.join(repoRoot, 'docker-compose.yml'),
            'services:\n  app:\n    image: example/app\n',
            'utf8'
        );
        fs.mkdirSync(path.join(repoRoot, 'src', 'main', 'kotlin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'main', 'kotlin', 'App.kt'), 'fun main() {}\n', 'utf8');

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/main/kotlin/App.kt'],
            taskId,
            taskIntent: 'Tune JVM heap.',
            outputPath,
            emitMetrics: false
        });

        assert.match(result.outputText, /"mode": "FULL_PATH"/);
        const preflightPayload = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
        const optionalSkillSelection = preflightPayload.optional_skill_selection as Record<string, unknown>;
        assert.equal(optionalSkillSelection.policy_mode, 'mandatory');
        assert.equal(optionalSkillSelection.decision, 'selected_installed_skills');
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-optional-skill-selection.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        const selectedSkills = artifact.selected_installed_skills as Array<Record<string, unknown>>;
        assert.deepEqual(selectedSkills.map((entry) => entry.id), ['devops-k8s']);
        assert.ok((selectedSkills[0].reason_codes as string[]).includes('stack_signals'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not materialize an optional-skill artifact when policy mode is off', () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-off.json');
        seedTaskQueue(repoRoot, 'T-900-off');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-900-off',
            taskSummary: 'Update app flow'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, 'T-900-off');
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-900-off');
        runShellSmokeForTask(repoRoot, 'T-900-off');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'off');

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/api/orders.ts'],
            taskId: 'T-900-off',
            taskIntent: 'Implement request validation for a Node.js API endpoint.',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText) as Record<string, unknown>;
        const persistedPayload = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
        const optionalSkillSelection = persistedPayload.optional_skill_selection as Record<string, unknown>;
        assert.equal((payload.optional_skill_selection as Record<string, unknown>).policy_mode, 'off');
        assert.equal(optionalSkillSelection.policy_mode, 'off');
        assert.equal(optionalSkillSelection.artifact_path, null);
        assert.equal(optionalSkillSelection.decision, null);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), 'T-900-off-optional-skill-selection.json')),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('marks zero-diff preflight as baseline-only instead of complete work', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-zero.json');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, 'T-900z');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-900z',
            taskSummary: 'Implement lifecycle hardening'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, 'T-900z');
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-900z');
        runShellSmokeForTask(repoRoot, 'T-900z');

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: [],
            taskId: 'T-900z',
            taskIntent: 'Implement lifecycle hardening',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.changed_files.length, 0);
        assert.equal(payload.zero_diff_guard.zero_diff_detected, true);
        assert.equal(payload.zero_diff_guard.status, 'BASELINE_ONLY');
        assert.equal(payload.zero_diff_guard.completion_requires_audited_no_op, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects POST_PREFLIGHT rule-pack when the current preflight has not completed classify-change sequencing', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-order';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject POST_PREFLIGHT load-rule-pack before classify-change completes'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false);
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOAD_FAILED');
        assertGateChainDecision(result.outputLines, {
            edgeId: 'preflight-to-post-preflight-rules',
            status: 'block',
            reason: 'Run classify-change to completion before load-rule-pack --stage POST_PREFLIGHT',
            remediation: 'node bin/garda.js gate classify-change --task-id'
        });
        assert.equal(artifact.stages.post_preflight.status, 'FAILED');
        assert.equal(artifact.stages.post_preflight.preflight_event_sequence, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate with gate-chain remediation when POST_PREFLIGHT rule-pack evidence is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-missing-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-missing.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Surface compile remediation when POST_PREFLIGHT rule-pack is missing'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Surface compile remediation when POST_PREFLIGHT rule-pack is missing',
            ['src/app.ts']
        );

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assertGateChainDecision(result.outputLines, {
            edgeId: 'post-preflight-rules-to-compile',
            status: 'block',
            reason: 'missing POST_PREFLIGHT RULE_PACK_LOADED evidence',
            remediation: 'node bin/garda.js gate load-rule-pack --task-id'
        });

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate with explicit sequencing remediation when POST_PREFLIGHT rule-pack already failed for the current preflight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-failed-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-failed.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Surface compile remediation after failed POST_PREFLIGHT sequencing'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false).exitCode, EXIT_GATE_FAILURE);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assertGateChainDecision(result.outputLines, {
            edgeId: 'preflight-to-post-preflight-rules',
            status: 'block',
            reason: 'Run classify-change to completion before load-rule-pack --stage POST_PREFLIGHT',
            remediation: 'node bin/garda.js gate classify-change --task-id'
        });

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects POST_PREFLIGHT rule-pack when a newer preflight already superseded the requested preflight artifact', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-stale-preflight';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale preflight artifacts during POST_PREFLIGHT rule-pack load'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const stalePreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale preflight artifacts during POST_PREFLIGHT rule-pack load',
            ['src/app.ts'],
            `${taskId}-stale-preflight.json`
        );
        const latestPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale preflight artifacts during POST_PREFLIGHT rule-pack load',
            ['src/app.ts']
        );

        const result = loadPostPreflightRulePack(repoRoot, taskId, stalePreflightPath);

        assert.equal(latestPreflightPath.endsWith(`${taskId}-preflight.json`), true);
        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOAD_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('not the latest PREFLIGHT_CLASSIFIED evidence')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps custom task-mode paths in POST_PREFLIGHT remediation commands', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-remediation-custom-task-mode';
        const customTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-custom-task-mode.json`);
        const preflightPath = writePreflight(repoRoot, taskId);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Preserve custom task-mode path in POST_PREFLIGHT remediation',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);

        const result = runLoadRulePackCommand({
            repoRoot,
            taskId,
            stage: 'POST_PREFLIGHT',
            preflightPath,
            taskModePath: customTaskModePath,
            loadedRuleFiles: ['00-core.md'],
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOAD_FAILED');
        const outputText = result.outputLines.join('\n');
        assert.ok(outputText.includes('Remediation:'), outputText);
        assert.ok(outputText.includes('--task-mode-path'), outputText);
        assert.ok(outputText.includes(customTaskModePath), outputText);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('materializes mandatory remediation evidence when a matching skill is missing SKILL.md', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-preflight-cleanup';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail classify-change when optional skill selection points at a missing skill file'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.mkdirSync(path.join(getOrchestratorRoot(repoRoot), 'live', 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'garda.config.json'),
            JSON.stringify({ version: 1, configs: { 'optional-skill-selection-policy': 'optional-skill-selection-policy.json' } }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'required' }, null, 2),
            'utf8'
        );

        const brokenSkillRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'skills', 'broken-skill');
        fs.mkdirSync(brokenSkillRoot, { recursive: true });
        fs.writeFileSync(
            path.join(brokenSkillRoot, 'skill.json'),
            JSON.stringify({
                id: 'broken-skill',
                pack: 'broken-pack',
                name: 'Broken Skill',
                summary: 'Broken skill fixture.',
                tags: ['broken', 'api'],
                aliases: ['broken'],
                references: [],
                cost_hint: 'low',
                priority: 50,
                autoload: 'suggest'
            }, null, 2),
            'utf8'
        );

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Implement broken-skill API validation.',
            changedFiles: ['src/app.ts'],
            outputPath: preflightPath,
            emitMetrics: false
        });

        // Skill without SKILL.md is excluded; classify-change still materializes evidence so next-step can route remediation.
        assert.match(result.outputText, /"mode": "FULL_PATH"/);
        assert.equal(fs.existsSync(preflightPath), true);
        const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const optionalSkillSelection = preflightPayload.optional_skill_selection as Record<string, unknown>;
        assert.equal(optionalSkillSelection.policy_mode, 'mandatory');
        assert.equal(optionalSkillSelection.decision, 'as_is');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps classify-change non-blocking in optional mode when skill has no SKILL.md', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-preflight-advisory';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep advisory optional skill selection non-blocking during classify-change'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.mkdirSync(path.join(getOrchestratorRoot(repoRoot), 'live', 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'garda.config.json'),
            JSON.stringify({ version: 1, configs: { 'optional-skill-selection-policy': 'optional-skill-selection-policy.json' } }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
            'utf8'
        );

        const brokenSkillRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'skills', 'broken-skill');
        fs.mkdirSync(brokenSkillRoot, { recursive: true });
        fs.writeFileSync(
            path.join(brokenSkillRoot, 'skill.json'),
            JSON.stringify({
                id: 'broken-skill',
                pack: 'broken-pack',
                name: 'Broken Skill',
                summary: 'Broken skill fixture.',
                tags: ['broken', 'api'],
                aliases: ['broken'],
                task_signals: ['broken-skill'],
                changed_path_signals: ['src/app.ts'],
                references: [],
                cost_hint: 'low',
                priority: 50,
                autoload: 'suggest'
            }, null, 2),
            'utf8'
        );

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Implement broken-skill API validation.',
            changedFiles: ['src/app.ts'],
            outputPath: preflightPath,
            emitMetrics: false
        });

        // Skill without SKILL.md is silently excluded; classify-change succeeds with as_is.
        assert.match(result.outputText, /"mode": "FULL_PATH"/);
        assert.equal(fs.existsSync(preflightPath), true);
        const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const optionalSkillSelection = preflightPayload.optional_skill_selection as Record<string, unknown>;
        assert.equal(optionalSkillSelection.policy_mode, 'optional');
        assert.equal(optionalSkillSelection.decision, 'as_is');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('binds optional-skill artifacts to the canonical TASK.md title when classify-change runs without task-intent', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-158-preflight-task-title-fallback';
        const taskTitle = 'Implement request validation for a Node.js API endpoint';
        const staleTaskModeSummary = 'Stale task-mode summary that should not override TASK.md';
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const order = 1;\n', 'utf8');
        fs.writeFileSync(
            path.join(repoRoot, 'TASK.md'),
            [
                '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                `| ${taskId} | TODO | P1 | api | ${taskTitle} | unassigned | 2026-04-20 | default | fixture |`
            ].join('\n'),
            'utf8'
        );
        seedInitAnswers(repoRoot);
        seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: staleTaskModeSummary
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            changedFiles: ['src/api/orders.ts'],
            outputPath: preflightPath,
            emitMetrics: false
        });

        assert.match(result.outputText, /"mode": "FULL_PATH"/);
        const optionalSkillArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-optional-skill-selection.json`);
        const optionalSkillArtifact = JSON.parse(fs.readFileSync(optionalSkillArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(optionalSkillArtifact.task_text_present, true);
        assert.equal(optionalSkillArtifact.task_text_sha256, computeTaskTextSha256(taskTitle));
        assert.equal(optionalSkillArtifact.selection_phase, 'pre_implementation');
        assert.equal(optionalSkillArtifact.path_evidence_source, 'explicit_scope');
        assert.equal(optionalSkillArtifact.visible_summary_line, 'Optional skills: node-backend (reason: task_text+paths)');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('marks optional-skill artifacts from actual workspace diffs as post-diff suggestions', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-158-preflight-post-diff-suggestion';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const order = 1;\n', 'utf8');
        initializeGitRepo(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const order = 2;\n', 'utf8');

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Implement request validation for a Node.js API endpoint',
            outputPath: preflightPath,
            emitMetrics: false
        });

        const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const optionalSkillSelection = preflightPayload.optional_skill_selection as Record<string, unknown>;
        assert.equal(optionalSkillSelection.selection_phase, 'post_diff');
        assert.equal(optionalSkillSelection.path_evidence_source, 'actual_changed_files');
        const optionalSkillArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-optional-skill-selection.json`);
        const optionalSkillArtifact = JSON.parse(fs.readFileSync(optionalSkillArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(optionalSkillArtifact.selection_phase, 'post_diff');
        assert.equal(optionalSkillArtifact.path_evidence_source, 'actual_changed_files');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('marks optional-skill artifacts from approved task-plan scope as pre-implementation', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-158-preflight-task-plan-scope';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const order = 1;\n', 'utf8');
        const planPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-plan.json`);
        fs.mkdirSync(path.dirname(planPath), { recursive: true });
        fs.writeFileSync(
            planPath,
            serializeTaskPlan({
                schema_version: 1,
                task_id: taskId,
                status: 'approved',
                goal: 'Implement request validation for a Node.js API endpoint',
                scope_files: ['src/api/orders.ts'],
                risk_level: 'medium',
                steps: [
                    {
                        id: 'step-1',
                        title: 'Update API handler'
                    }
                ]
            }),
            'utf8'
        );

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint',
            planPath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const order = 2;\n', 'utf8');

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Implement request validation for a Node.js API endpoint',
            outputPath: preflightPath,
            emitMetrics: false
        });

        const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const optionalSkillSelection = preflightPayload.optional_skill_selection as Record<string, unknown>;
        assert.equal(optionalSkillSelection.selection_phase, 'pre_implementation');
        assert.equal(optionalSkillSelection.path_evidence_source, 'task_plan_scope');
        const optionalSkillArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-optional-skill-selection.json`);
        const optionalSkillArtifact = JSON.parse(fs.readFileSync(optionalSkillArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(optionalSkillArtifact.selection_phase, 'pre_implementation');
        assert.equal(optionalSkillArtifact.path_evidence_source, 'task_plan_scope');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails classify-change when garda.config.json maps a missing optional-skill-selection policy file', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-preflight-missing-policy';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail classify-change when mapped optional skill policy config is missing'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        seedNodeBackendOptionalSkillFixture(repoRoot, 'required');
        fs.rmSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'optional-skill-selection-policy.json'),
            { force: true }
        );

        assert.throws(
            () => runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Fail classify-change when mapped optional skill policy config is missing.',
                changedFiles: ['src/api/orders.ts'],
                outputPath: path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`),
                emitMetrics: false
            }),
            /Managed optional skill selection policy config is missing/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('blocks compile-gate before implementation starts when required optional-skill evidence is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-compile-required-optional-skill';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeConfiguredCompileGate(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const order = 1;\n', 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'required');
        initializeGitRepo(repoRoot);

        const commandsPath = path.join(repoRoot, 'commands-optional-skill-required.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Block implementation start when required optional-skill evidence is missing'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Block implementation start when required optional-skill evidence is missing',
            ['src/api/orders.ts']
        );
        const optionalSkillArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-optional-skill-selection.json`);
        assert.equal(fs.existsSync(optionalSkillArtifactPath), true);
        fs.rmSync(optionalSkillArtifactPath, { force: true });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Optional skill selection artifact is missing for current task cycle')));
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'IMPLEMENTATION_STARTED'),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
