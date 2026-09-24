import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';
import { isPathInsideRoot } from '../../core/paths';
import { runContractMigrations } from '../../lifecycle/contract-migrations';
import { type CheckUpdateRunnerOptions } from '../../lifecycle/check-update';
import { runUpdate } from '../../lifecycle/update';
import { formatManifestResult, formatVerifyResult, runVerify, validateManifest } from '../../validators';

interface HandoffRequest {
    bundleRoot: string;
    runnerOptions: CheckUpdateRunnerOptions;
    fallbackDryRun?: boolean;
}

export function runUpdateRuntimeHandoff(request: HandoffRequest) {
    const installedBundleRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const requestedRoot = fs.realpathSync.native(request.bundleRoot);
    const installedRoot = fs.realpathSync.native(installedBundleRoot);
    if (!isPathInsideRoot(installedRoot, requestedRoot)
        || !isPathInsideRoot(requestedRoot, installedRoot)
        || !['enforced', 'overridden'].includes(request.runnerOptions.trustPolicy)) {
        throw new Error('Updated bundle lifecycle handoff rejected an unbound bundle or source.');
    }

    const options = request.runnerOptions;
    return runUpdate({
        targetRoot: options.targetRoot,
        bundleRoot: installedBundleRoot,
        initAnswersPath: options.initAnswersPath,
        dryRun: request.fallbackDryRun,
        skipVerify: options.skipVerify,
        skipManifestValidation: options.skipManifestValidation,
        trustContext: {
            policy: options.trustPolicy,
            overrideUsed: options.trustOverrideUsed,
            overrideSource: options.trustOverrideSource,
            sourceType: options.sourceType,
            sourceReference: options.sourceReference,
            gitCommitSha: options.gitCommitSha || null,
            requestedPackageSpec: options.requestedPackageSpec || null,
            exactPackageSpec: options.exactPackageSpec || null,
            resolvedPackageVersion: options.resolvedPackageVersion || null,
            resolvedPackageIntegrity: options.resolvedPackageIntegrity || null,
            releaseProvenanceStatus: options.releaseProvenanceStatus || null,
            releaseProvenanceSummary: options.releaseProvenanceSummary || null,
            releaseProvenanceRecommendation: options.releaseProvenanceRecommendation || null
        },
        lifecycleLockAlreadyHeld: options.lifecycleLockAlreadyHeld === true,
        contractMigrationRunner: runContractMigrations,
        verifyRunner(verifyOptions) {
            const result = runVerify({
                targetRoot: verifyOptions.targetRoot,
                initAnswersPath: verifyOptions.initAnswersPath,
                sourceOfTruth: verifyOptions.sourceOfTruth
            });
            if (!result.passed) {
                throw new Error(formatVerifyResult(result));
            }
            return result;
        },
        manifestRunner(manifestOptions) {
            const manifestPath = path.join(manifestOptions.targetRoot, resolveBundleName(), 'MANIFEST.md');
            const result = validateManifest(manifestPath, manifestOptions.targetRoot);
            if (!result.passed) {
                throw new Error(formatManifestResult(result));
            }
            return result;
        }
    });
}

if (require.main === module) {
    try {
        const request = JSON.parse(fs.readFileSync(0, 'utf8')) as HandoffRequest;
        fs.writeSync(3, JSON.stringify({ result: runUpdateRuntimeHandoff(request) }));
    } catch (error) {
        fs.writeSync(3, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        process.exitCode = 1;
    }
}
