import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';

import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import {
    computeOptionalSkillSelectionFingerprint,
    computeOptionalSkillTaskTextSha256
} from '../../../../src/runtime/optional-skill-selection';
import { serializeTaskPlan } from '../../../../src/schemas/task-plan';
import { runCliWithCapturedOutput } from './gate-test-helpers';
import {
    createTempRepo,
    runEnterTaskMode,
    seedInitAnswers,
    seedTaskQueue,
    writePreflight
} from './gate-test-helpers';

function seedNodeBackendOptionalSkillFixture(
    bundleRoot: string,
    options: {
        policyMode?: 'optional' | 'mandatory' | 'advisory' | 'required' | 'strict' | 'off' | null;
        includePersistedHeadlines?: boolean;
    } = {}
): void {
    const configDir = path.join(bundleRoot, 'live', 'config');
    const skillRoot = path.join(bundleRoot, 'live', 'skills', 'node-backend');
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
    if (options.policyMode !== null) {
        fs.writeFileSync(
            path.join(configDir, 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: options.policyMode || 'advisory' }, null, 2),
            'utf8'
        );
    }
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
    if (options.includePersistedHeadlines === true) {
        fs.writeFileSync(
            path.join(configDir, 'skills-headlines.json'),
            JSON.stringify({
                version: 2,
                source_state_sha256: 'fixture-source-state',
                installed_pack_ids: ['node-backend'],
                baseline_skill_ids: [],
                installed_optional_skill_ids: ['node-backend'],
                custom_skill_ids: [],
                skills: [
                    {
                        id: 'node-backend',
                        directory: 'node-backend',
                        name: 'Node Backend',
                        summary: 'Node backend specialist for request validation and API work.',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        implemented: true,
                        review_binding: 'general_purpose',
                        aliases: ['node', 'node-backend'],
                        task_signals: ['api endpoint', 'node-backend', 'request validation'],
                        changed_path_signals: ['orders.ts', 'src/api/'],
                        tags: ['api', 'backend', 'node']
                    }
                ],
                optional_packs: []
            }, null, 2),
            'utf8'
        );
    }
}

function seedTelegramCustomSkillFixture(
    bundleRoot: string,
    options: {
        policyMode?: 'optional' | 'mandatory' | 'advisory' | 'required' | 'strict' | 'off' | null;
    } = {}
): void {
    const configDir = path.join(bundleRoot, 'live', 'config');
    const skillRoot = path.join(bundleRoot, 'live', 'skills', 'telegram-tdlight');
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
        JSON.stringify({ version: 1, installed_packs: [] }, null, 2),
        'utf8'
    );
    if (options.policyMode !== null) {
        fs.writeFileSync(
            path.join(configDir, 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: options.policyMode || 'advisory' }, null, 2),
            'utf8'
        );
    }
    fs.writeFileSync(
        path.join(skillRoot, 'skill.json'),
        JSON.stringify({
            id: 'telegram-tdlight',
            name: 'Telegram TDLight',
            summary: 'Custom Telegram TDLight specialist for session and client runtime work.',
            tags: ['custom', 'telegram', 'tdlight'],
            aliases: ['telegram-tdlight', 'tdlight'],
            task_signals: ['telegram tdlight', 'tdlight session'],
            changed_path_signals: ['src/telegram/'],
            references: [],
            cost_hint: 'medium',
            priority: 75,
            autoload: 'suggest'
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Telegram TDLight\n', 'utf8');
}



function sha256File(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeSelectedNodeBackendOptionalSkillArtifact(
    repoRoot: string,
    taskId: string,
    options: {
        policyMode: 'optional' | 'mandatory' | 'advisory' | 'required' | 'strict';
        preflightPath: string;
        selectionPhase?: 'pre_implementation' | 'post_diff';
        pathEvidenceSource?: 'planned_changed_files' | 'explicit_scope' | 'actual_changed_files';
    }
): void {
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const artifactPath = path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(
        artifactPath,
        JSON.stringify({
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: taskId,
            timestamp_utc: new Date().toISOString(),
            policy_mode: options.policyMode,
            decision: 'selected_installed_skills',
            selection_phase: options.selectionPhase || 'pre_implementation',
            path_evidence_source: options.pathEvidenceSource || 'explicit_scope',
            selected_installed_skills: [
                {
                    id: 'node-backend',
                    pack: 'node-backend',
                    source: 'installed_optional',
                    allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                    reason_codes: ['task_signals', 'changed_path_signals'],
                    matches: {
                        task_signals: ['node-backend'],
                        changed_path_signals: ['orders.ts']
                    }
                }
            ],
            recommended_missing_packs: [],
            as_is_reason: null,
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
            changed_paths: ['src/api/orders.ts'],
            preflight_path: options.preflightPath.replace(/\\/g, '/'),
            preflight_sha256: sha256File(options.preflightPath),
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: null,
            visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
        }, null, 2),
        'utf8'
    );
}

function appendOptionalSkillActivationEvent(repoRoot: string, taskId: string, skillId = 'node-backend'): void {
    const artifactPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'reviews',
        `${taskId}-optional-skill-selection.json`
    );
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    const timestampUtc = new Date(Date.parse(String(artifact.timestamp_utc || new Date().toISOString())) + 1000).toISOString();
    const eventsPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.appendFileSync(
        eventsPath,
        `${JSON.stringify({
            timestamp_utc: timestampUtc,
            event_type: 'SKILL_SELECTED',
            details: {
                skill_id: skillId,
                trigger_reason: 'optional_skill_selection'
            }
        })}\n`,
        'utf8'
    );
}

function appendOptionalSkillDeclineEvent(repoRoot: string, taskId: string, skillId = 'node-backend'): void {
    const artifactPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'reviews',
        `${taskId}-optional-skill-selection.json`
    );
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
    const timestampUtc = new Date(Date.parse(String(artifact.timestamp_utc || new Date().toISOString())) + 1000).toISOString();
    const eventsPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.appendFileSync(
        eventsPath,
        `${JSON.stringify({
            timestamp_utc: timestampUtc,
            event_type: 'SKILL_DECLINED',
            details: {
                skill_id: skillId,
                trigger_reason: 'optional_skill_selection',
                optional_skill_selection_fingerprint_sha256: artifact.selection_fingerprint_sha256 || null,
                reason: 'not needed for current implementation'
            }
        })}\n`,
        'utf8'
    );
}

test('preprompt task --json shows optional skill selection preview from headlines-based selection', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.policy_mode, 'optional');
        assert.equal(optionalSkills.decision, 'selected_installed_skills');
        assert.deepEqual(optionalSkills.selected_installed_skills, ['node-backend']);
        assert.deepEqual(optionalSkills.selected_installed_skill_paths, [
            'garda-agent-orchestrator/live/skills/node-backend/SKILL.md'
        ]);
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.match(String(optionalSkills.selected_installed_skill_activation_blocker || ''), /requires a current materialized selection artifact/i);
        assert.deepEqual(optionalSkills.selected_installed_skill_activation_commands, []);
        assert.match(String(optionalSkills.skill_catalog_path || ''), /garda-agent-orchestrator\/live\/config\/skills-headlines\.json/);
        assert.match(String(optionalSkills.task_start_instruction || ''), /Selected optional skill\(s\): node-backend/);
        assert.match(String(optionalSkills.task_start_instruction || ''), /activate the selected skill/i);
        assert.match(String(optionalSkills.visible_summary_line || ''), /Optional skills: node-backend/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json shows custom live specialist skill source details', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Fix Telegram TDLight session recovery'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/telegram/client.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedTelegramCustomSkillFixture(bundleRoot, {
            policyMode: 'advisory'
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.policy_mode, 'optional');
        assert.equal(optionalSkills.decision, 'selected_installed_skills');
        assert.deepEqual(optionalSkills.selected_installed_skills, ['telegram-tdlight']);
        assert.deepEqual(optionalSkills.selected_installed_skill_sources, ['custom_live']);
        assert.deepEqual(optionalSkills.selected_installed_skill_paths, [
            'garda-agent-orchestrator/live/skills/telegram-tdlight/SKILL.md'
        ]);
        const details = optionalSkills.selected_installed_skill_details as Array<Record<string, unknown>>;
        assert.equal(details[0].id, 'telegram-tdlight');
        assert.equal(details[0].source, 'custom_live');
        assert.equal(details[0].pack, 'custom');
        assert.match(String(optionalSkills.task_start_instruction || ''), /Selected optional skill\(s\): telegram-tdlight/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json keeps current optional-skill activation guidance non-blocking', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });
        writeSelectedNodeBackendOptionalSkillArtifact(repoRoot, taskId, {
            policyMode: 'advisory',
            preflightPath,
            selectionPhase: 'post_diff',
            pathEvidenceSource: 'actual_changed_files'
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.policy_mode, 'optional');
        assert.equal(optionalSkills.selection_phase, 'post_diff');
        assert.equal(optionalSkills.path_evidence_source, 'actual_changed_files');
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.equal(optionalSkills.selected_installed_skill_post_diff_self_check, true);
        assert.deepEqual(optionalSkills.selected_installed_skill_activation_commands, []);
        assert.match(
            String(optionalSkills.task_start_instruction || ''),
            /Selected optional skill\(s\): node-backend/
        );
        assert.match(
            String(optionalSkills.task_start_instruction || ''),
            /post-diff changed paths/
        );
        assert.match(
            String(optionalSkills.task_start_instruction || ''),
            /self-check only/
        );
        assert.doesNotMatch(
            String(optionalSkills.task_start_instruction || ''),
            /run the activation command\(s\)/i
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json blocks mandatory optional-skill artifacts with mismatched phase/source evidence', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });
        writeSelectedNodeBackendOptionalSkillArtifact(repoRoot, taskId, {
            policyMode: 'required',
            preflightPath,
            selectionPhase: 'pre_implementation',
            pathEvidenceSource: 'actual_changed_files'
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.policy_mode, 'mandatory');
        assert.match(String(optionalSkills.blocker || ''), /actual_changed_files.*post_diff/u);
        assert.match(String(optionalSkills.task_start_instruction || ''), /artifact is invalid.*Rerun classify-change/iu);
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.deepEqual(optionalSkills.selected_installed_skill_activation_commands, []);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json treats mandatory post-diff missing-pack recommendations as self-check only', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });
        fs.mkdirSync(path.join(bundleRoot, 'template', 'skill-packs'), { recursive: true });
        fs.cpSync(
            path.join(process.cwd(), 'template', 'skill-packs', 'frontend-react'),
            path.join(bundleRoot, 'template', 'skill-packs', 'frontend-react'),
            { recursive: true }
        );
        const headlinesPath = path.join(bundleRoot, 'live', 'config', 'skills-headlines.json');
        const headlines = JSON.parse(fs.readFileSync(headlinesPath, 'utf8')) as Record<string, unknown>;
        headlines.optional_packs = [
            {
                id: 'frontend-react',
                label: 'Frontend React',
                description: 'Frontend React specialist pack.',
                installed: false,
                implemented: true,
                collides_with_baseline: false,
                ready_skill_ids: ['frontend-react'],
                placeholder_skill_ids: [],
                recommended_for: ['React apps', 'UI tasks'],
                tags: ['frontend', 'react']
            }
        ];
        fs.writeFileSync(headlinesPath, JSON.stringify(headlines, null, 2), 'utf8');
        const artifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: taskId,
            timestamp_utc: new Date().toISOString(),
            policy_mode: 'required',
            decision: 'recommended_missing_packs',
            selection_phase: 'post_diff',
            path_evidence_source: 'actual_changed_files',
            selected_installed_skills: [],
            recommended_missing_packs: [
                {
                    id: 'frontend-react',
                    label: 'Frontend React',
                    ready_skill_ids: ['frontend-react'],
                    reason_codes: ['task_signals' as const],
                    matches: {
                        task_signals: ['react'],
                        changed_path_signals: []
                    }
                }
            ],
            as_is_reason: null,
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
            changed_paths: ['src/api/orders.ts'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: sha256File(preflightPath),
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: null,
            visible_summary_line: 'Optional skills: recommended_missing_packs (packs: frontend-react, reason: task_text)'
        };
        Object.assign(artifact, {
            selection_fingerprint_sha256: computeOptionalSkillSelectionFingerprint(artifact)
        });
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify(artifact, null, 2),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.selection_phase, 'post_diff');
        assert.equal(optionalSkills.path_evidence_source, 'actual_changed_files');
        assert.deepEqual(optionalSkills.recommended_missing_packs, ['frontend-react']);
        assert.equal(optionalSkills.blocker, null);
        assert.match(String(optionalSkills.task_start_instruction || ''), /self-check only/u);
        assert.doesNotMatch(String(optionalSkills.task_start_instruction || ''), /before implementation|rerun classify-change|activation before/iu);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json treats mandatory post-diff as_is outcomes as self-check only', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });
        const artifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: taskId,
            timestamp_utc: new Date().toISOString(),
            policy_mode: 'required',
            decision: 'as_is',
            selection_phase: 'post_diff',
            path_evidence_source: 'actual_changed_files',
            selected_installed_skills: [],
            recommended_missing_packs: [],
            as_is_reason: 'generic_context_sufficient',
            task_text_present: true,
            task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
            changed_paths: ['src/api/orders.ts'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: sha256File(preflightPath),
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: null,
            visible_summary_line: 'Optional skills: as_is (reason: generic_context_sufficient)'
        };
        Object.assign(artifact, {
            selection_fingerprint_sha256: computeOptionalSkillSelectionFingerprint(artifact)
        });
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify(artifact, null, 2),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.selection_phase, 'post_diff');
        assert.equal(optionalSkills.path_evidence_source, 'actual_changed_files');
        assert.equal(optionalSkills.as_is_reason, 'generic_context_sufficient');
        assert.equal(optionalSkills.blocker, null);
        assert.match(String(optionalSkills.task_start_instruction || ''), /self-check only/u);
        assert.doesNotMatch(String(optionalSkills.task_start_instruction || ''), /before implementation|rerun classify-change|activation before/iu);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json treats legacy required policy as mandatory activation guidance', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });
        writeSelectedNodeBackendOptionalSkillArtifact(repoRoot, taskId, {
            policyMode: 'required',
            preflightPath
        });
        appendOptionalSkillActivationEvent(repoRoot, taskId);

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.policy_mode, 'mandatory');
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, true);
        assert.match(
            String(optionalSkills.task_start_instruction || ''),
            /Selected optional skill\(s\): node-backend/
        );
        assert.match(
            String(optionalSkills.task_start_instruction || ''),
            /Run the activation command\(s\) before implementation so the timeline records the required chosen role\/skill/
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json summarizes explicitly declined advisory optional skills without activation commands', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });
        writeSelectedNodeBackendOptionalSkillArtifact(repoRoot, taskId, {
            policyMode: 'advisory',
            preflightPath
        });
        appendOptionalSkillDeclineEvent(repoRoot, taskId);

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.policy_mode, 'optional');
        assert.deepEqual(optionalSkills.selected_installed_skill_declined_ids, ['node-backend']);
        assert.deepEqual(optionalSkills.selected_installed_skill_activation_commands, []);
        assert.deepEqual(optionalSkills.selected_installed_skill_decline_commands, []);
        assert.match(String(optionalSkills.task_start_instruction || ''), /Explicit non-use is recorded/u);
        assert.doesNotMatch(String(optionalSkills.task_start_instruction || ''), /Run the activation command/iu);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json keeps stale mandatory optional-skill activation blocked after preflight refresh', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });
        writeSelectedNodeBackendOptionalSkillArtifact(repoRoot, taskId, {
            policyMode: 'required',
            preflightPath
        });

        const artifactPath = path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        const artifactTimestampMs = Date.parse(String(artifact.timestamp_utc));
        const eventsPath = path.join(bundleRoot, 'runtime', 'task-events', `${taskId}.jsonl`);
        fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
        const eventLine = (
            offsetMs: number,
            eventType: string,
            details?: Record<string, unknown>
        ) => JSON.stringify({
            timestamp_utc: new Date(artifactTimestampMs + offsetMs).toISOString(),
            event_type: eventType,
            ...(details ? { details } : {})
        });
        fs.writeFileSync(eventsPath, [
            eventLine(1000, 'SKILL_SELECTED', {
                skill_id: 'node-backend',
                trigger_reason: 'optional_skill_selection',
                optional_skill_selection_fingerprint_sha256: computeOptionalSkillSelectionFingerprint(
                    artifact as Parameters<typeof computeOptionalSkillSelectionFingerprint>[0]
                )
            }),
            eventLine(2000, 'PREFLIGHT_CLASSIFIED', {
                output_path: preflightPath.replace(/\\/g, '/')
            })
        ].join('\n') + '\n', 'utf8');

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.policy_mode, 'mandatory');
        assert.match(
            String(optionalSkills.blocker || ''),
            /current-cycle activation evidence for selected optional skill\(s\): node-backend/
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json reports optional skills as disabled when policy mode is off', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            },
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'off',
            includePersistedHeadlines: true
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.policy_mode, 'off');
        assert.equal(optionalSkills.decision, null);
        assert.deepEqual(optionalSkills.selected_installed_skills, []);
        assert.equal(optionalSkills.as_is_reason, 'policy_off');
        assert.equal(optionalSkills.blocker, null);
        assert.match(String(optionalSkills.visible_summary_line || ''), /Optional skills: as_is \(reason: policy_off\)/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json blocks required optional-skill policy until the current-cycle artifact is materialized, while still exposing the preview decision', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
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
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.policy_mode, 'mandatory');
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.decision, 'selected_installed_skills');
        assert.deepEqual(optionalSkills.selected_installed_skills, ['node-backend']);
        assert.match(String(optionalSkills.blocker || ''), /requires a materialized current-cycle selection artifact/i);
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.match(
            String(optionalSkills.selected_installed_skill_activation_blocker || ''),
            /requires a current materialized selection artifact/i
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task text output reports required optional-skill blocker before exiting non-zero', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
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
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const output = result.logs.join('\n');
        assert.match(output, /GARDA_PREPROMPT_TASK/);
        assert.match(output, /OptionalSkillTaskStartBlocker:/);
        assert.match(output, /OptionalSkillTaskStartInstruction:/);
        assert.match(output, /Selected optional skill\(s\): node-backend/);
        assert.match(output, /requires a materialized current-cycle selection artifact/i);
        assert.deepEqual(result.errors, []);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json keeps advisory optional-skill preview available when persisted headlines are missing', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
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
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: false
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.policy_mode, 'optional');
        assert.equal(optionalSkills.blocker, null);
        assert.equal(optionalSkills.decision, 'selected_installed_skills');
        assert.equal(optionalSkills.selection_phase, 'pre_implementation');
        assert.equal(optionalSkills.path_evidence_source, 'explicit_scope');
        assert.deepEqual(optionalSkills.selected_installed_skills, ['node-backend']);
        assert.deepEqual(optionalSkills.selected_installed_skill_paths, [
            'garda-agent-orchestrator/live/skills/node-backend/SKILL.md'
        ]);
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.match(String(optionalSkills.selected_installed_skill_activation_blocker || ''), /requires a current materialized selection artifact/i);
        assert.deepEqual(optionalSkills.selected_installed_skill_activation_commands, []);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json derives optional-skill phase from approved task-plan scope', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/api/orders.ts']
        });
        const planPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-task-plan.json`);
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

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: false
        });
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint',
            planPath
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.decision, 'selected_installed_skills');
        assert.equal(optionalSkills.selection_phase, 'pre_implementation');
        assert.equal(optionalSkills.path_evidence_source, 'task_plan_scope');
        assert.deepEqual(optionalSkills.selected_installed_skills, ['node-backend']);
        assert.equal(preflightPath.endsWith(`${taskId}-preflight.json`), true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json reports structured optional-skill diagnostics when the policy config is malformed', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            '{',
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.current_policy_mode, null);
        assert.match(String(optionalSkills.blocker || ''), /preview is unavailable/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json fails fast when garda.config.json maps a missing optional-skill-selection policy file', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });
        fs.rmSync(
            path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json'),
            { force: true }
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.current_policy_mode, null);
        assert.match(String(optionalSkills.blocker || ''), /policy config is missing/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json derives optional-skill preview from task-mode planned scope before preflight exists', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Harden entry flow sequencing for the current task'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: false
        });
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Harden entry flow sequencing for the current task',
            plannedChangedFiles: ['src/api/orders.ts']
        });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const commands = payload.commands as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, false);
        assert.equal(optionalSkills.policy_mode, 'optional');
        assert.equal(optionalSkills.blocker, null);
        assert.equal(optionalSkills.decision, 'selected_installed_skills');
        assert.equal(optionalSkills.selection_phase, 'pre_implementation');
        assert.equal(optionalSkills.path_evidence_source, 'planned_changed_files');
        assert.deepEqual(optionalSkills.selected_installed_skills, ['node-backend']);
        assert.deepEqual(optionalSkills.selected_installed_skill_paths, [
            'garda-agent-orchestrator/live/skills/node-backend/SKILL.md'
        ]);
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.match(String(optionalSkills.selected_installed_skill_activation_blocker || ''), /requires a current materialized selection artifact/i);
        assert.deepEqual(optionalSkills.selected_installed_skill_activation_commands, []);
        assert.deepEqual(commands.startup_commands, []);
        const continuation = payload.continuation as Record<string, unknown>;
        assert.equal(continuation.revalidate_before_action, true);
        assert.notEqual(continuation.next_gate, 'enter-task-mode');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json recomputes advisory optional-skill preview instead of reusing a stale materialized artifact', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Tighten task-audit-summary closeout wiring'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            changed_files: ['src/gates/task-audit-summary.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });
        fs.mkdirSync(path.join(bundleRoot, 'runtime', 'reviews'), { recursive: true });
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify({
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: taskId,
                timestamp_utc: new Date().toISOString(),
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: {
                            task_signals: ['node-backend'],
                            changed_path_signals: ['orders.ts']
                        }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.relative(repoRoot, preflightPath).replace(/\\/g, '/'),
                preflight_sha256: 'stale-preflight-hash',
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: 'stale-headlines-hash',
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            }, null, 2),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, true);
        assert.equal(optionalSkills.decision, 'as_is');
        assert.deepEqual(optionalSkills.selected_installed_skills, []);
        assert.match(String(optionalSkills.skill_catalog_path || ''), /garda-agent-orchestrator\/live\/config\/skills-headlines\.json/);
        assert.match(String(optionalSkills.task_start_instruction || ''), /No specialized optional skill selected/);
        assert.match(String(optionalSkills.task_start_instruction || ''), /Compact catalog: garda-agent-orchestrator\/live\/config\/skills-headlines\.json/);
        assert.match(String(optionalSkills.visible_summary_line || ''), /^Optional skills: as_is \(reason: /);
        assert.equal(optionalSkills.blocker, null);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json recomputes optional-skill preview when the materialized artifact points to a skill missing from the current live inventory', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
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
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });
        const preflightPath = path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-preflight.json`);
        const preflightSha256 = childProcess.execFileSync(
            process.execPath,
            ['-e', `const fs=require('node:fs');const crypto=require('node:crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(preflightPath)})).digest('hex'));`],
            { encoding: 'utf8' }
        ).trim();
        const headlinesPath = path.join(bundleRoot, 'live', 'config', 'skills-headlines.json');
        const persistedHeadlinesSha256 = childProcess.execFileSync(
            process.execPath,
            ['-e', `const fs=require('node:fs');const crypto=require('node:crypto');const text=fs.readFileSync(${JSON.stringify(headlinesPath)},'utf8').trim()+'\\n';process.stdout.write(crypto.createHash('sha256').update(text,'utf8').digest('hex'));`],
            { encoding: 'utf8' }
        ).trim();
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify({
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: taskId,
                timestamp_utc: new Date().toISOString(),
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: {
                            task_signals: ['node-backend'],
                            changed_path_signals: ['orders.ts']
                        }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-149-preflight.json',
                preflight_sha256: preflightSha256,
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: persistedHeadlinesSha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            }, null, 2),
            'utf8'
        );
        fs.rmSync(path.join(bundleRoot, 'live', 'skills', 'node-backend'), { recursive: true, force: true });

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, true);
        assert.equal(optionalSkills.decision, 'as_is');
        assert.deepEqual(optionalSkills.selected_installed_skills, []);
        assert.equal(optionalSkills.selected_installed_skill_activation_ready, false);
        assert.match(String(optionalSkills.visible_summary_line || ''), /^Optional skills: as_is \(reason: /);
        assert.equal(optionalSkills.blocker, null);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json recomputes optional-skill preview when the current TASK.md title no longer matches the materialized task summary hash', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            changed_files: ['docs/landing.md']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'advisory',
            includePersistedHeadlines: true
        });
        const preflightSha256 = childProcess.execFileSync(
            process.execPath,
            ['-e', `const fs=require('node:fs');const crypto=require('node:crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(preflightPath)})).digest('hex'));`],
            { encoding: 'utf8' }
        ).trim();
        const headlinesPath = path.join(bundleRoot, 'live', 'config', 'skills-headlines.json');
        const persistedHeadlinesSha256 = childProcess.execFileSync(
            process.execPath,
            ['-e', `const fs=require('node:fs');const crypto=require('node:crypto');const text=fs.readFileSync(${JSON.stringify(headlinesPath)},'utf8').trim()+'\\n';process.stdout.write(crypto.createHash('sha256').update(text,'utf8').digest('hex'));`],
            { encoding: 'utf8' }
        ).trim();
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify({
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: taskId,
                timestamp_utc: new Date().toISOString(),
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals'],
                        matches: {
                            task_signals: ['node-backend'],
                            changed_path_signals: []
                        }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['docs/landing.md'],
                preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-149-preflight.json',
                preflight_sha256: preflightSha256,
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: persistedHeadlinesSha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
            }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Implement request validation for a Node.js API endpoint',
                'Refresh landing-page copy for the marketing site'
            ),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, 0);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, true);
        assert.equal(optionalSkills.decision, 'as_is');
        assert.deepEqual(optionalSkills.selected_installed_skills, []);
        assert.equal(optionalSkills.blocker, null);
        assert.match(String(optionalSkills.visible_summary_line || ''), /^Optional skills: as_is \(reason: /);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json reports a blocker when an existing optional-skill artifact no longer matches the current preflight', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'required',
            includePersistedHeadlines: true
        });
        fs.mkdirSync(path.join(bundleRoot, 'runtime', 'reviews'), { recursive: true });
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify({
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: taskId,
                timestamp_utc: new Date().toISOString(),
                policy_mode: 'required',
                decision: 'selected_installed_skills',
                selection_phase: 'pre_implementation',
                path_evidence_source: 'explicit_scope',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: {
                            task_signals: ['node-backend'],
                            changed_path_signals: ['orders.ts']
                        }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.relative(repoRoot, preflightPath).replace(/\\/g, '/'),
                preflight_sha256: 'stale-preflight-hash',
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: 'stale-headlines-hash',
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            }, null, 2),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.equal(optionalSkills.artifact_present, true);
        assert.match(String(optionalSkills.blocker || ''), /current preflight artifact/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('preprompt task --json reports a blocker when an existing optional-skill artifact no longer matches the current policy mode', async () => {
    const repoRoot = createTempRepo();
    const taskId = 'T-149';
    try {
        seedTaskQueue(repoRoot, taskId, '🟨 IN_PROGRESS');
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId, {
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
            changed_files: ['src/api/orders.ts']
        });

        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        seedNodeBackendOptionalSkillFixture(bundleRoot, {
            policyMode: 'strict',
            includePersistedHeadlines: true
        });
        fs.writeFileSync(
            path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`),
            JSON.stringify({
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: taskId,
                timestamp_utc: new Date().toISOString(),
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                selection_phase: 'pre_implementation',
                path_evidence_source: 'explicit_scope',
                selected_installed_skills: [
                    {
                        id: 'node-backend',
                        pack: 'node-backend',
                        source: 'installed_optional',
                        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                        reason_codes: ['task_signals'],
                        matches: {
                            task_signals: ['node-backend'],
                            changed_path_signals: []
                        }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeOptionalSkillTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-149-preflight.json',
                preflight_sha256: 'stale-preflight-hash',
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: 'stale-headlines-hash',
                visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
            }, null, 2),
            'utf8'
        );

        const result = await runCliWithCapturedOutput(
            ['preprompt', 'task', '--task-id', taskId, '--json'],
            { cwd: repoRoot }
        );

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        const payload = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
        const diagnostics = payload.diagnostics as Record<string, unknown>;
        const optionalSkills = diagnostics.optional_skills as Record<string, unknown>;
        assert.match(String(optionalSkills.blocker || ''), /current policy mode 'mandatory'/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
