import * as path from 'node:path';
import { createInvocationReadMemoKey, memoizeInvocationRead } from '../../core/invocation-read-observation';
import { countNextStepWork } from '../../core/next-step-measurement';
import { readTaskModeInvocationText, resolveTaskModeInvocationPath, taskModeInvocationFileExists, taskModeInvocationRepoKey } from './task-mode-invocation-observation';

import {
    getProviderEntriesByEntrypointFile,
    normalizeProviderId
} from '../../core/provider-registry';
import { getProviderOrchestratorProfileDefinitions } from '../../materialization/common';
import { joinOrchestratorPath } from '../shared/helpers';
import type { TaskModeEvidenceResult } from './task-mode-contracts';

const LEGACY_CANONICAL_SOURCE = createInvocationReadMemoKey<string | null>('task-mode-legacy-canonical-source');

function normalizeLegacySourceOfTruthValue(value: unknown): string | null {
    return normalizeProviderId(value);
}

function normalizeLegacyRoutePath(value: unknown): string | null {
    const text = String(value || '').trim().replace(/\\/g, '/');
    if (!text) {
        return null;
    }
    return text.replace(/^\.\//, '');
}

function readLegacyCanonicalSourceOfTruth(repoRoot: string): string | null {
    return memoizeInvocationRead(LEGACY_CANONICAL_SOURCE, taskModeInvocationRepoKey(repoRoot), () => {
        countNextStepWork('derive:task_mode_legacy_identity_source');
        return captureLegacyCanonicalSourceOfTruth(repoRoot);
    }).value;
}

function captureLegacyCanonicalSourceOfTruth(repoRoot: string): string | null {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const initAnswersPath = resolveTaskModeInvocationPath(JSON.stringify(['legacy-init', taskModeInvocationRepoKey(repoRoot)]),
        () => joinOrchestratorPath(normalizedRepoRoot, path.join('runtime', 'init-answers.json')));
    if (taskModeInvocationFileExists(initAnswersPath)) {
        try {
            const initAnswers = JSON.parse(readTaskModeInvocationText(initAnswersPath)) as Record<string, unknown>;
            const sourceOfTruth = normalizeLegacySourceOfTruthValue(initAnswers.SourceOfTruth);
            if (sourceOfTruth) {
                return sourceOfTruth;
            }
        } catch {
            // Legacy compatibility fallback only.
        }
    }

    const liveVersionPath = resolveTaskModeInvocationPath(JSON.stringify(['legacy-version', taskModeInvocationRepoKey(repoRoot)]),
        () => joinOrchestratorPath(normalizedRepoRoot, path.join('live', 'version.json')));
    if (taskModeInvocationFileExists(liveVersionPath)) {
        try {
            const liveVersion = JSON.parse(readTaskModeInvocationText(liveVersionPath)) as Record<string, unknown>;
            return normalizeLegacySourceOfTruthValue(liveVersion.SourceOfTruth);
        } catch {
            // Legacy compatibility fallback only.
        }
    }

    return null;
}

export function resolveLegacyRouteIdentity(routedTo: string | null): {
    provider: string | null;
    routeKind: 'provider_bridge' | 'provider_entrypoint' | null;
} {
    const normalizedRoute = normalizeLegacyRoutePath(routedTo);
    if (!normalizedRoute) {
        return {
            provider: null,
            routeKind: null
        };
    }

    for (const profile of getProviderOrchestratorProfileDefinitions()) {
        if (normalizeLegacyRoutePath(profile.orchestratorRelativePath) === normalizedRoute) {
            return {
                provider: normalizeLegacySourceOfTruthValue(profile.providerId),
                routeKind: 'provider_bridge'
            };
        }
    }

    const sharedEntrypointProviders = getProviderEntriesByEntrypointFile(normalizedRoute)
        .map((entry) => normalizeLegacySourceOfTruthValue(entry.id))
        .filter((provider): provider is string => provider !== null);
    if (sharedEntrypointProviders.length === 1) {
        return {
            provider: sharedEntrypointProviders[0],
            routeKind: 'provider_entrypoint'
        };
    }

    return {
        provider: null,
        routeKind: null
    };
}

export function applyLegacyTaskModeIdentityBackfill(repoRoot: string, result: TaskModeEvidenceResult): void {
    const legacyRoutingMetadataMissing = (
        result.reviewer_capability_level == null
        && result.reviewer_expected_execution_mode == null
        && result.reviewer_fallback_allowed == null
        && result.reviewer_fallback_reason_required == null
    );
    const identityMetadataMissing = !result.canonical_source_of_truth || !result.execution_provider_source || !result.runtime_identity_status;
    if (
        !legacyRoutingMetadataMissing
        || !identityMetadataMissing
        || result.declares_runtime_identity_metadata
        || result.timeline_declares_runtime_identity_metadata
    ) {
        return;
    }

    applyCapturedLegacyTaskModeIdentityBackfill(readLegacyCanonicalSourceOfTruth(repoRoot), result);
}

/** Pure identity projection; fallback files are read only after the legacy guard above. */
function applyCapturedLegacyTaskModeIdentityBackfill(
    workspaceCanonicalSourceOfTruth: string | null, result: TaskModeEvidenceResult
): void {
    const provider = normalizeLegacySourceOfTruthValue(result.provider);
    const routeIdentity = resolveLegacyRouteIdentity(result.routed_to);
    if (!workspaceCanonicalSourceOfTruth || !provider) {
        return;
    }
    let executionProvider = provider;
    if (routeIdentity.provider && routeIdentity.provider !== provider) {
        if (routeIdentity.routeKind === 'provider_bridge' && provider === workspaceCanonicalSourceOfTruth) {
            executionProvider = routeIdentity.provider;
        } else {
            result.runtime_identity_violations = [
                ...result.runtime_identity_violations,
                `Legacy task-mode routed_to '${result.routed_to}' identifies provider '${routeIdentity.provider}', ` +
                `but legacy task-mode provider is '${provider}'.`
            ];
            return;
        }
    }

    result.provider = executionProvider;
    result.canonical_source_of_truth = result.canonical_source_of_truth || workspaceCanonicalSourceOfTruth;
    result.execution_provider_source = result.execution_provider_source
        || routeIdentity.routeKind
        || (executionProvider === workspaceCanonicalSourceOfTruth ? 'provider_entrypoint' : 'explicit_provider');
    result.runtime_identity_status = result.runtime_identity_status || 'resolved';
    result.identity_backfilled_from_legacy = true;
}
