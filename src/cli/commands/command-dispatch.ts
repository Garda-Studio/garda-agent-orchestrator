import { PRIMARY_PACKAGE_NAME } from '../../core/constants';
import {
    detectSourceBundleParity,
    detectSourceCheckoutRuntimeStaleness
} from '../../validators/workspace-layout';
import { assertOfflinePolicy } from '../../policy/offline-mode';
import { EXIT_VALIDATION_FAILURE } from '../exit-codes';
import {
    buildParityBlockedCommandText,
    buildParityWarningCommandText
} from './cli-format-output';
import { isFailedValidationResult } from './shared-command-utils';
import { PackageJsonLike, printHelp } from './cli-helpers';
import {
    buildParityHelpText,
    isHelpOnlyRequest,
    isMissingDeployedBundleOnlyParityBlock,
    printCommandHelpIfRequested,
    printHelpCommand
} from './dispatch/help-routing';
import { resolveCommandParityPolicy } from './dispatch/parity-policy';

export interface DispatchCliCommandOptions {
    commandName: string;
    commandArgv: string[];
    packageJson: PackageJsonLike;
    packageRoot: string;
    globalFlags: {
        offline: boolean;
        forceNetwork: boolean;
    };
}

export async function dispatchCliCommand(options: DispatchCliCommandOptions): Promise<void> {
    const { commandName, commandArgv, packageJson, packageRoot, globalFlags } = options;
    const isIntrospection = commandArgv.some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v');
    const isHelpOnly = isHelpOnlyRequest(commandArgv);
    const isNextStepNavigatorCommand = commandName === 'next-step'
        || (commandName === 'gate' && String(commandArgv[0] || '').trim() === 'next-step');

    if (commandName === 'help') {
        if (!printHelpCommand(commandArgv, packageJson)) {
            printHelp(packageJson);
        }
        return;
    }

    if (!isIntrospection) {
        assertOfflinePolicy({
            offlineFlag: globalFlags.offline,
            offlineEnv: process.env.GARDA_OFFLINE,
            forceNetwork: globalFlags.forceNetwork,
            commandName
        });
    }

    const parityPolicy = resolveCommandParityPolicy(commandName, commandArgv);
    if (parityPolicy.mode !== 'skip') {
        const parityRoot = parityPolicy.root;
        const parityResult = detectSourceBundleParity(parityRoot);
        if (parityResult.isStale && !(isHelpOnly && isMissingDeployedBundleOnlyParityBlock(parityResult.violations))) {
            if (parityPolicy.mode === 'block') {
                throw new Error(
                    buildParityBlockedCommandText({
                        commandName,
                        helpText: buildParityHelpText(commandName, commandArgv, packageJson, parityRoot),
                        violations: parityResult.violations,
                        remediation: parityResult.remediation || `Run "npm run build" then "npx ${PRIMARY_PACKAGE_NAME} setup".`,
                        parityRoot,
                        policyMode: parityPolicy.mode,
                        policyReason: parityPolicy.reason
                    })
                );
            }
            console.error(
                buildParityWarningCommandText({
                    commandName,
                    violations: parityResult.violations,
                    remediation: parityResult.remediation || `Run "npm run build" then "npx ${PRIMARY_PACKAGE_NAME} setup".`,
                    parityRoot,
                    policyMode: parityPolicy.mode,
                    policyReason: parityPolicy.reason
                })
            );
        }
        if (!isIntrospection && (commandName === 'gate' || commandName === 'next-step') && !isNextStepNavigatorCommand) {
            const runtimeStaleness = detectSourceCheckoutRuntimeStaleness(parityRoot);
            if (runtimeStaleness.isStale) {
                console.error(
                    [
                        'Source Runtime Warning: source checkout generated runtime may be stale.',
                        ...runtimeStaleness.violations.map((violation) => `- ${violation}`),
                        `Remediation: ${runtimeStaleness.remediation || 'Run "npm run build" before continuing gate execution.'}`
                    ].join('\n')
                );
            }
        }
    }

    if (printCommandHelpIfRequested(commandName, commandArgv)) {
        return;
    }

    switch (commandName) {
        case 'setup': {
            const { handleSetup } = await import('./setup');
            await handleSetup(commandArgv, packageJson, packageRoot);
            return;
        }
        case 'agent-init': {
            const { handleAgentInit } = await import('./agent-init');
            const result = handleAgentInit(commandArgv, packageJson);
            if (result && result.readyForTasks === false) {
                process.exitCode = EXIT_VALIDATION_FAILURE;
            }
            return;
        }
        case 'preprompt': {
            const { handlePreprompt } = await import('./preprompt-command');
            handlePreprompt(commandArgv, packageJson);
            return;
        }
        case 'compact': {
            const { handleCompact } = await import('./compact-command');
            await handleCompact(commandArgv);
            return;
        }
        case 'next-step': {
            const { handleGate } = await import('./gate-command');
            await handleGate(['next-step', ...commandArgv]);
            return;
        }
        case 'status': {
            const { handleStatus } = await import('./status-command');
            handleStatus(commandArgv, packageJson);
            return;
        }
        case 'doctor': {
            const { handleDoctor } = await import('./status-command');
            handleDoctor(commandArgv, packageJson);
            return;
        }
        case 'debug': {
            const { handleDebug } = await import('./debug-command');
            handleDebug(commandArgv, packageJson);
            return;
        }
        case 'stats': {
            const { handleStats } = await import('./debug-command');
            handleStats(commandArgv, packageJson);
            return;
        }
        case 'task': {
            const { handleTask } = await import('./task-command');
            await handleTask(commandArgv, packageJson);
            return;
        }
        case 'html': {
            const { handleHtml } = await import('./html-command');
            handleHtml(commandArgv, packageJson);
            return;
        }
        case 'ui': {
            const { handleUi } = await import('./ui-command');
            await handleUi(commandArgv, packageJson);
            return;
        }
        case 'on':
        case 'off': {
            const { handleSwitchMode } = await import('./switch-command');
            handleSwitchMode(commandName, commandArgv, packageJson);
            return;
        }
        case 'bootstrap': {
            const { handleBootstrap } = await import('./bootstrap');
            await handleBootstrap(commandArgv, packageJson, packageRoot);
            return;
        }
        case 'install': {
            const { handleInstall } = await import('./workspace-command');
            await handleInstall(commandArgv, packageJson, packageRoot);
            return;
        }
        case 'init': {
            const { handleInit } = await import('./workspace-command');
            handleInit(commandArgv, packageJson);
            return;
        }
        case 'reinit': {
            const { handleReinit } = await import('./workspace-maintenance-command');
            await handleReinit(commandArgv, packageJson);
            return;
        }
        case 'update': {
            const { handleUpdate } = await import('./update-command');
            await handleUpdate(commandArgv, packageJson);
            return;
        }
        case 'rollback': {
            const { handleRollback } = await import('./update-command');
            await handleRollback(commandArgv, packageJson);
            return;
        }
        case 'backup': {
            const { handleBackup } = await import('./backup-command');
            await handleBackup(commandArgv, packageJson);
            return;
        }
        case 'uninstall': {
            const { handleUninstall } = await import('./workspace-maintenance-command');
            handleUninstall(commandArgv, packageJson);
            return;
        }
        case 'cleanup': {
            const { handleCleanup } = await import('./workspace-maintenance-command');
            await Promise.resolve(handleCleanup(commandArgv, packageJson));
            return;
        }
        case 'repair': {
            const { handleRepair } = await import('./repair-command');
            handleRepair(commandArgv, packageJson);
            return;
        }
        case 'gc':
        case 'clean': {
            const { handleGc } = await import('./workspace-maintenance-command');
            handleGc(commandArgv, packageJson);
            return;
        }
        case 'verify': {
            const { handleVerify } = await import('./validate-command');
            handleVerify(commandArgv, packageJson);
            return;
        }
        case 'check-update': {
            const { handleCheckUpdate } = await import('./update-command');
            await handleCheckUpdate(commandArgv, packageJson);
            return;
        }
        case 'skills': {
            const { handleSkills } = await import('./skills');
            const result = handleSkills(commandArgv, packageJson);
            if (isFailedValidationResult(result)) {
                process.exitCode = EXIT_VALIDATION_FAILURE;
            }
            return;
        }
        case 'review-capabilities': {
            const { handleReviewCapabilities } = await import('./review-capabilities-command');
            const result = handleReviewCapabilities(commandArgv, packageJson);
            if (isFailedValidationResult(result)) {
                process.exitCode = EXIT_VALIDATION_FAILURE;
            }
            return;
        }
        case 'review-catalog': {
            const { handleReviewCatalog } = await import('./review-catalog-command');
            const result = handleReviewCatalog(commandArgv, packageJson);
            if (isFailedValidationResult(result)) {
                process.exitCode = EXIT_VALIDATION_FAILURE;
            }
            return;
        }
        case 'templates': {
            const { handleTemplates } = await import('./templates-command');
            const result = handleTemplates(commandArgv, packageJson);
            if (isFailedValidationResult(result)) {
                process.exitCode = EXIT_VALIDATION_FAILURE;
            }
            return;
        }
        case 'profile': {
            const { handleProfile } = await import('./profile');
            const profileResult = await Promise.resolve(handleProfile(commandArgv, packageJson));
            if (isFailedValidationResult(profileResult)) {
                process.exitCode = EXIT_VALIDATION_FAILURE;
            }
            return;
        }
        case 'workflow': {
            const { handleWorkflow } = await import('./workflow-command');
            const workflowResult = handleWorkflow(commandArgv, packageJson);
            if (isFailedValidationResult(workflowResult)) {
                process.exitCode = EXIT_VALIDATION_FAILURE;
            }
            return;
        }
        case 'diff-managed': {
            const { handleDiffManaged } = await import('./debug-command');
            handleDiffManaged(commandArgv, packageJson);
            return;
        }
        case 'gate': {
            const { handleGate } = await import('./gate-command');
            await handleGate(commandArgv);
            return;
        }
        default:
            throw new Error(`Unsupported command: ${commandName}`);
    }
}
