import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    buildDefaultWorkflowConfig as buildSourceDefaultWorkflowConfig,
    type WorkflowConfigData
} from '../../../../src/core/workflow-config';
import {
    getWorkspaceSnapshot as getSourceWorkspaceSnapshot
} from '../../../../src/gates/compile/compile-gate';
import {
    getWorkspaceSnapshotCached as getSourceWorkspaceSnapshotCached
} from '../../../../src/gates/workspace/workspace-snapshot-cache';
import {
    buildRulePackArtifact as buildSourceRulePackArtifact,
    type BuildRulePackArtifactOptions,
    type RulePackArtifact
} from '../../../../src/gates/rule-pack';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import {
    executeNextStepEffects as executeSourceNextStepEffects,
    resolveNextStep as inspectSourceNextStep
} from '../../../../src/gates/next-step';
import { bindFixtureEffectiveReviewSnapshot } from '../../cli/commands/gate-test-seed-helpers';
import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';

function ensureGitWorkspaceFixture(repoRoot: string, changedFiles: readonly string[]): void {
    if (fs.existsSync(path.join(repoRoot, '.git'))) {
        return;
    }

    const materializedScope = [...new Set(changedFiles)]
        .map((relativePath) => {
            const absolutePath = path.resolve(repoRoot, relativePath);
            const relativeToRoot = path.relative(repoRoot, absolutePath);
            if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
                throw new Error(`Test changed-file fixture must stay inside repo root: ${relativePath}`);
            }
            const existed = fs.existsSync(absolutePath);
            const content = existed ? fs.readFileSync(absolutePath) : null;
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, Buffer.alloc(0));
            return { absolutePath, content, existed };
        });

    try {
        initGitRepo(repoRoot, {
            gitignoreContent: 'TASK.md\ngarda-agent-orchestrator/runtime/\n'
        });
    } finally {
        for (const entry of materializedScope) {
            if (entry.existed && entry.content) {
                fs.writeFileSync(entry.absolutePath, entry.content);
            } else if (fs.existsSync(entry.absolutePath)) {
                fs.unlinkSync(entry.absolutePath);
            }
        }
    }
}

export function getWorkspaceSnapshot(
    ...args: Parameters<typeof getSourceWorkspaceSnapshot>
): ReturnType<typeof getSourceWorkspaceSnapshot> {
    ensureGitWorkspaceFixture(
        args[0],
        args[1] === 'explicit_changed_files' ? args[3] : []
    );
    return getSourceWorkspaceSnapshot(...args);
}

export function getWorkspaceSnapshotCached(
    ...args: Parameters<typeof getSourceWorkspaceSnapshotCached>
): ReturnType<typeof getSourceWorkspaceSnapshotCached> {
    ensureGitWorkspaceFixture(
        args[0],
        args[1] === 'explicit_changed_files' ? args[3] : []
    );
    return getSourceWorkspaceSnapshotCached(...args);
}

export function commitGitFixturePaths(
    repoRoot: string,
    relativePaths: readonly string[],
    message = 'test: refresh fixture baseline'
): void {
    runGitFixtureCommand(repoRoot, ['add', '--', ...relativePaths]);
    runGitFixtureCommand(repoRoot, ['commit', '-m', message, '--', ...relativePaths]);
}

export function getGitFixtureHead(repoRoot: string): string {
    return runGitFixtureCommand(repoRoot, ['rev-parse', 'HEAD']).stdout.trim();
}

export function buildDefaultWorkflowConfig(): WorkflowConfigData {
    const config = buildSourceDefaultWorkflowConfig();
    config.optional_quality_checks.enabled = false;
    return config;
}

export function writeBalancedTestProfilesConfig(repoRoot: string): string {
    const configPath = path.join(
        path.resolve(repoRoot),
        'garda-agent-orchestrator',
        'live',
        'config',
        'profiles.json'
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Balanced next-step test profile',
                depth: 2,
                review_policy: { code: 'auto', test: 'auto' },
                token_economy: {
                    enabled: true,
                    strip_examples: true,
                    strip_code_blocks: true,
                    scoped_diffs: true,
                    compact_reviewer_output: true
                },
                skills: { auto_suggest: true },
                task_decomposition: { enabled: false }
            }
        },
        user_profiles: {}
    }, null, 2)}\n`, 'utf8');
    return configPath;
}

export { bindFixtureEffectiveReviewSnapshot };

export function buildRulePackArtifact(options: BuildRulePackArtifactOptions): RulePackArtifact {
    if (options.stage === 'POST_PREFLIGHT' && options.preflightPath) {
        const preflightPath = path.resolve(options.preflightPath);
        if (fs.existsSync(preflightPath) && fs.statSync(preflightPath).isFile()) {
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            if (preflight.effective_review_snapshot === undefined) {
                const requiredReviews = preflight.required_reviews
                && typeof preflight.required_reviews === 'object'
                && !Array.isArray(preflight.required_reviews)
                    ? preflight.required_reviews as Record<string, unknown>
                    : {};
                const reviewKey = Object.entries(requiredReviews)
                    .find(([, required]) => required === true)?.[0] || 'code';
                bindFixtureEffectiveReviewSnapshot(
                    options.repoRoot,
                    options.taskId,
                    reviewKey,
                    preflightPath,
                    String(options.taskModePath || ''),
                    { ensureSkillEntrypoints: false }
                );
                const boundPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
                appendTaskEvent(
                    path.join(path.resolve(options.repoRoot), 'garda-agent-orchestrator'),
                    options.taskId,
                    'PREFLIGHT_CLASSIFIED',
                    'INFO',
                    'Fixture preflight classified with immutable review routing evidence.',
                    {
                        output_path: preflightPath.replace(/\\/g, '/'),
                        effective_review_snapshot: boundPreflight.effective_review_snapshot
                    }
                );
            }
        }
    }
    return buildSourceRulePackArtifact(options);
}

export { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../../src/core/project-memory';

export function resolveNextStep(
    ...args: Parameters<typeof inspectSourceNextStep>
): ReturnType<typeof inspectSourceNextStep> {
    let result = inspectSourceNextStep(...args);
    for (let effectBatch = 0; effectBatch < 16 && result.next_gate === 'next-step-effect'; effectBatch += 1) {
        const planSha256 = (result.commands[0]?.command || '')
            .match(/--effect-plan-sha256\s+["']?([a-f0-9]{64})/u)?.[1] || '';
        if (!planSha256) {
            throw new Error('Test next-step compatibility execution did not receive a guarded effect-plan hash.');
        }
        result = executeSourceNextStepEffects(args[0], planSha256);
    }
    if (result.next_gate === 'next-step-effect') {
        throw new Error('Test next-step compatibility execution exceeded 16 guarded effect batches.');
    }
    return result;
}

export {
    COPILOT_PROVIDER_ENV_KEYS,
    getProviderRuntimeEnvironmentKeys
} from '../../../../src/core/provider-registry';
export { buildEventIntegrityHash } from '../../../../src/gate-runtime/task-events-helpers';
export { recordFullSuiteValidationDuration, type FullSuiteValidationConfig } from '../../../../src/gates/full-suite/full-suite-validation';
export {
    buildReviewReuseCandidatesForDiagnostics,
    executeNextStepEffects,
    formatNextStepText,
    resolveNextStep as inspectNextStep,
    resolveNextStepDecisionRoute
} from '../../../../src/gates/next-step';
export {
    extractExplicitLinkedChildTaskIds,
    formatDecomposedTaskProvenanceNote,
    readDecomposedTaskProvenance
} from '../../../../src/gates/next-step/next-step-task-queue';
export {
    readReadyFinalReportSummary
} from '../../../../src/gates/next-step/next-step-closeout-status-readers';
export { assessProjectMemoryImpact, getProjectMemoryImpactLifecycleEvidence } from '../../../../src/gates/project-memory-impact';
export { buildDomainScopeFingerprints } from '../../../../src/gates/scope/domain-scope-fingerprints';
export { buildTaskAuditSummary, synchronizeFinalCloseoutArtifacts } from '../../../../src/gates/task-audit/task-audit-summary';
export { buildTaskModeArtifact } from '../../../../src/gates/task-mode';
export { buildStrictDecompositionDecisionArtifact } from '../../../../src/gates/task-mode/strict-decomposition-decision';
