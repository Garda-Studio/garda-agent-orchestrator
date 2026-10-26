import { measureNextStepPhase } from '../../core/next-step-measurement';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    resolveBundleNameForTarget
} from '../../core/constants';
import {
    assertValidTaskId
} from '../../gate-runtime/task-events';
import {
    resolveEventsRoot,
    resolveReviewsRoot
} from '../task-audit/task-audit-summary-collectors';
import {
    isPathRealpathInsideRoot,
    normalizePath
} from '../shared/helpers';
import {
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    readNextStepReadinessArtifacts,
    type NextStepReadinessArtifacts
} from './next-step-readiness-readers';
import {
    resolveActiveTaskModeArtifactPath
} from './next-step-preflight-recovery';

export interface NextStepOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
}

export interface NextStepResolutionContext {
    repoRoot: string;
    taskId: string;
    reviewsRoot: string;
    eventsRoot: string;
    cliPrefix: string;
    taskModePath: string;
    preflightCommandPath: string;
    readinessArtifacts: NextStepReadinessArtifacts;
    preflightPath: string;
    rulePackPath: string;
    preflight: Record<string, unknown> | null;
    rulePack: Record<string, unknown> | null;
    taskMode: Record<string, unknown> | null;
    preflightSha256: string | null;
    taskEventsPath: string;
}

export function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? 'node bin/garda.js'
        : `node ${resolveBundleNameForTarget(repoRoot)}/bin/garda.js`;
}

function assertRuntimeRootInsideRepo(repoRoot: string, runtimeRoot: string, label: string): void {
    if (isPathRealpathInsideRoot(runtimeRoot, repoRoot, { allowMissing: true })) {
        return;
    }
    throw new Error(
        `${label} must resolve inside repo root without symlink or junction escape: ${normalizePath(runtimeRoot)}.`
    );
}

export function createNextStepResolutionContext(options: NextStepOptions): NextStepResolutionContext {
    return measureNextStepPhase('context', () => {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = assertValidTaskId(options.taskId);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    assertRuntimeRootInsideRepo(repoRoot, reviewsRoot, 'ReviewsRoot');
    assertRuntimeRootInsideRepo(repoRoot, eventsRoot, 'EventsRoot');
    const cliPrefix = buildCliPrefix(repoRoot);
    const taskModePath = resolveActiveTaskModeArtifactPath(repoRoot, eventsRoot, reviewsRoot, taskId);
    const preflightArtifactPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflightCommandPath = toRepoDisplayPath(repoRoot, preflightArtifactPath);
    const readinessArtifacts = readNextStepReadinessArtifacts({
        reviewsRoot,
        taskId,
        taskModePath,
        preflightCommandPath
    });
    const { preflightPath, rulePackPath } = readinessArtifacts.paths;
    const { preflight, rulePack, taskMode, preflightSha256 } = readinessArtifacts;

    return {
        repoRoot,
        taskId,
        reviewsRoot,
        eventsRoot,
        cliPrefix,
        taskModePath,
        preflightCommandPath,
        readinessArtifacts,
        preflightPath,
        rulePackPath,
        preflight,
        rulePack,
        taskMode,
        preflightSha256,
        taskEventsPath: path.join(eventsRoot, `${taskId}.jsonl`)
    };

    });
}
