import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildRulePackArtifact } from '../../../../src/gates/rule-pack/rule-pack-artifact-build';
import type { RulePackArtifact } from '../../../../src/gates/rule-pack/rule-pack-types';
import { buildTaskModeArtifact } from '../../../../src/gates/task-mode';
import { createTempRepo, getReviewsRoot } from '../../cli/commands/gate-test-repo-bootstrap';
import { bindFixtureEffectiveReviewSnapshot } from '../../cli/commands/gate-test-seed-helpers';

export const TASK_ID = 'T-041-TEST';
export const RULE_NAMES = [
    '00-core.md', '15-project-memory.md', '40-commands.md',
    '80-task-workflow.md', '90-skill-catalog.md'
];

export interface RulePackFixture {
    repoRoot: string;
    artifactPath: string;
    preflightPath: string;
    changedFilePath: string;
    readArtifact(): RulePackArtifact;
    writeArtifact(artifact: RulePackArtifact): void;
    append(eventType: string, details: Record<string, unknown>): void;
}

export function createRulePackFixture(t: Pick<TestContext, 'after'>): RulePackFixture {
    const repoRoot = createTempRepo(t);
    const reviewsRoot = getReviewsRoot(repoRoot);
    const artifactPath = path.join(reviewsRoot, `${TASK_ID}-rule-pack.json`);
    const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
    const taskModePath = path.join(reviewsRoot, `${TASK_ID}-task-mode.json`);
    const changedFilePath = path.join(repoRoot, 'tests', 'node', 'rule-pack-fixture.test.ts');
    const normalized = (filePath: string): string => filePath.replace(/\\/gu, '/');
    const append = (eventType: string, details: Record<string, unknown>): void => {
        appendTaskEvent(path.join(repoRoot, 'garda-agent-orchestrator'), TASK_ID,
            eventType, 'PASS', eventType, details);
    };
    const writeArtifact = (artifact: RulePackArtifact): void => {
        fs.writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');
    };

    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(taskModePath, JSON.stringify(buildTaskModeArtifact({
        taskId: TASK_ID,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Rule-pack lifecycle test',
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved'
    })), 'utf8');
    append('TASK_MODE_ENTERED', { artifact_path: normalized(taskModePath) });

    writeArtifact(buildRulePackArtifact({ repoRoot, taskId: TASK_ID, stage: 'TASK_ENTRY',
        loadedRuleFiles: RULE_NAMES }));
    append('RULE_PACK_LOADED', { stage: 'TASK_ENTRY', artifact_path: normalized(artifactPath) });

    fs.mkdirSync(path.dirname(changedFilePath), { recursive: true });
    fs.writeFileSync(changedFilePath, 'export {};\n', 'utf8');
    const requiredReviews = Object.fromEntries([
        'code', 'db', 'security', 'refactor', 'api', 'test', 'performance', 'infra', 'dependency'
    ].map((lane) => [lane, lane === 'test']));
    fs.writeFileSync(preflightPath, JSON.stringify({
        task_id: TASK_ID,
        mode: 'FULL_PATH',
        scope_category: 'test-only',
        changed_files: ['tests/node/rule-pack-fixture.test.ts'],
        required_reviews: requiredReviews
    }), 'utf8');
    bindFixtureEffectiveReviewSnapshot(repoRoot, TASK_ID, 'test', preflightPath, '');
    append('PREFLIGHT_CLASSIFIED', { output_path: normalized(preflightPath) });

    writeArtifact(buildRulePackArtifact({ repoRoot, taskId: TASK_ID, stage: 'POST_PREFLIGHT',
        preflightPath, loadedRuleFiles: RULE_NAMES }));
    append('RULE_PACK_LOADED', {
        stage: 'POST_PREFLIGHT', artifact_path: normalized(artifactPath), preflight_path: normalized(preflightPath)
    });

    return {
        repoRoot,
        artifactPath,
        preflightPath,
        changedFilePath,
        readArtifact: () => JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as RulePackArtifact,
        writeArtifact,
        append
    };
}
