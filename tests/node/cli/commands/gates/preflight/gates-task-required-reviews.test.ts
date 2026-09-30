import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runClassifyChangeCommand } from '../../../../../../src/cli/commands/gates';
import {
    captureExpectedError,
    createTempRepo,
    getReviewsRoot,
    loadTaskEntryRulePack,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue
} from './gates-preflight-fixtures';

function seedBalancedProfileConfig(repoRoot: string, apiCapability: boolean, profileName = 'balanced'): void {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'review-capabilities.json'), JSON.stringify({
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: apiCapability,
        test: true,
        performance: true,
        infra: true,
        dependency: true
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: profileName,
        built_in_profiles: {
            [profileName]: {
                description: 'Balanced',
                depth: 2,
                review_policy: {
                    code: true,
                    db: 'auto',
                    security: 'auto',
                    refactor: 'auto',
                    api: profileName === 'fast' ? false : 'auto',
                    test: 'auto',
                    performance: 'auto',
                    infra: 'auto',
                    dependency: 'auto'
                },
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
    }, null, 2), 'utf8');
}

function prepareTask(repoRoot: string, taskId: string, notes: string, apiCapability: boolean, profileName = 'balanced'): void {
    seedBalancedProfileConfig(repoRoot, apiCapability, profileName);
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'export const suite = true;\n', 'utf8');
    seedTaskQueue(
        repoRoot,
        taskId,
        'TODO',
        profileName,
        notes,
        'Add guarded local UI policy API flow'
    );
    seedInitAnswers(repoRoot);
    runEnterTaskMode({
        repoRoot,
        taskId,
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Add guarded local profile preview flow'
    });
    assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
}

describe('classify-change task required-review metadata', () => {
    it('keeps an explicit API lane even when fast profile defaults disable it', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-required-api-fast';
        try {
            prepareTask(repoRoot, taskId, 'Required reviews: code, api, test.', true, 'fast');
            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Change local diagnostics',
                changedFiles: ['src/app.ts', 'tests/app.test.ts'],
                outputPath: path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`),
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText) as Record<string, any>;
            assert.equal(payload.required_reviews.api, true);
            const apiLane = payload.effective_review_snapshot.lanes.find((lane: Record<string, unknown>) => lane.id === 'api');
            assert.equal(apiLane.profile.state, 'disabled');
            assert.equal(apiLane.selection, 'required');
            assert.ok(payload.effective_review_snapshot.review_dependency_graph.nodes.includes('api'));
            assert.ok(payload.budget_forecast.required_reviews.includes('api'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps explicit available lanes under balanced profile policy', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-33-3-shaped';
        try {
            prepareTask(
                repoRoot,
                taskId,
                'Scope: local UI action flow. Required reviews: code, api, test. Parent guard preserved.',
                true
            );

            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Add guarded local profile preview flow',
                changedFiles: ['src/app.ts', 'tests/app.test.ts'],
                outputPath: path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`),
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText) as Record<string, any>;

            assert.equal(payload.triggers.api_intent, false);
            assert.deepEqual(payload.task_required_review_declaration, {
                source: 'task_queue_notes',
                declared_reviews: ['code', 'api', 'test'],
                applied_reviews: ['code', 'api', 'test']
            });
            assert.equal(payload.required_reviews.code, true);
            assert.equal(payload.required_reviews.api, true);
            assert.equal(payload.required_reviews.test, true);
            assert.equal(
                payload.profile_guardrails.decisions.find(
                    (decision: Record<string, unknown>) => decision.review_type === 'api'
                )?.decision,
                'preflight_required'
            );
            assert.deepEqual(payload.budget_forecast.required_reviews.sort(), ['api', 'code', 'test']);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails preflight with the unavailable lane reason instead of dropping it', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-required-api-unavailable';
        try {
            prepareTask(repoRoot, taskId, 'Required reviews: code, api, test.', false);

            const error = captureExpectedError(() => runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Add guarded local profile preview flow',
                changedFiles: ['src/app.ts', 'tests/app.test.ts'],
                outputPath: path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`),
                emitMetrics: false
            }));

            assert.match(
                error.message,
                /Task 'T-required-api-unavailable' required-review declaration cannot be honored: review lane 'api' is unavailable because review-capabilities\.api is not enabled\./
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
