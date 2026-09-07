import {
    applyNoColorFlag,
    extractGlobalFlags,
    normalizePathValue,
    readPackageJson
} from './commands/cli-helpers';
import {
    getCommandName,
    getPackageRoot,
    ValidationFailureError
} from './commands/shared-command-utils';
import {
    buildTaskResetNearMissError,
    resolveTaskResetAlias
} from './commands/task-reset-alias';
import { installSignalHandlers } from './signal-handler';
import {
    classifyErrorExitCode,
    EXIT_VALIDATION_FAILURE
} from './exit-codes';
import { CliPathContainmentError } from '../core/cli-path-input-policy';

let resolvedCommand: string | null = null;
let resolvedGateCommand: string | null = null;

function getFailureMarker(command: string | null): string {
    if (!command || command === 'bootstrap') {
        return 'GARDA_BOOTSTRAP_FAILED';
    }
    return 'GARDA_CLI_FAILED';
}

function getPathContainmentFailureMarker(error: CliPathContainmentError): string {
    if (error.flagName !== '--preflight-path') {
        return getFailureMarker(resolvedCommand);
    }
    if (resolvedGateCommand === 'required-reviews-check') {
        return 'REVIEW_GATE_FAILED';
    }
    if (resolvedGateCommand === 'full-suite-validation') {
        return 'FULL_SUITE_VALIDATION_FAILED';
    }
    if (resolvedGateCommand === 'compile-gate') {
        return 'COMPILE_GATE_FAILED';
    }
    return getFailureMarker(resolvedCommand);
}

export async function runCliRuntimeMain(
    argv: string[] = process.argv.slice(2),
    packageRoot = getPackageRoot()
): Promise<void> {
    installSignalHandlers();

    const globalFlags = extractGlobalFlags(argv);
    applyNoColorFlag(globalFlags.noColor);
    const effectiveArgv = globalFlags.rest;
    const packageJson = readPackageJson(packageRoot);

    if (effectiveArgv.length === 0) {
        const { handleOverview } = await import('./commands/overview');
        handleOverview(packageJson, normalizePathValue('.'));
        return;
    }
    if (effectiveArgv[0] === '--help' || effectiveArgv[0] === '-h') {
        const { printHelp } = await import('./commands/cli-helpers');
        printHelp(packageJson);
        return;
    }
    if (effectiveArgv[0] === '--version' || effectiveArgv[0] === '-v') {
        console.log(packageJson.version);
        return;
    }

    const taskResetAlias = resolveTaskResetAlias(effectiveArgv);
    const commandName = taskResetAlias ? 'gate' : getCommandName(effectiveArgv);
    resolvedCommand = commandName;

    const commandArgv = taskResetAlias
        ? ['task-reset', ...taskResetAlias.commandArgv]
        : effectiveArgv.slice(1);
    resolvedGateCommand = commandName === 'gate'
        ? String(commandArgv[0] || '').trim() || null
        : null;

    if (!taskResetAlias) {
        const taskResetNearMissError = buildTaskResetNearMissError(effectiveArgv);
        if (taskResetNearMissError) {
            resolvedCommand = 'gate';
            throw new Error(taskResetNearMissError);
        }
    }

    const { dispatchCliCommand } = await import('./commands/command-dispatch');
    await dispatchCliCommand({
        commandName,
        commandArgv,
        packageJson,
        packageRoot,
        globalFlags: {
            offline: globalFlags.offline,
            forceNetwork: globalFlags.forceNetwork
        }
    });
}

export async function runCliRuntimeMainWithHandling(
    argv: string[] = process.argv.slice(2),
    packageRoot = getPackageRoot()
): Promise<void> {
    try {
        await runCliRuntimeMain(argv, packageRoot);
    } catch (error: unknown) {
        if (error instanceof CliPathContainmentError) {
            console.error(getPathContainmentFailureMarker(error));
            console.error(error.message);
            process.exitCode = classifyErrorExitCode(error);
            return;
        }
        if (error instanceof ValidationFailureError) {
            console.error(getFailureMarker(resolvedCommand));
            console.error(error.message);
            process.exitCode = EXIT_VALIDATION_FAILURE;
            return;
        }

        console.error(getFailureMarker(resolvedCommand));
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = classifyErrorExitCode(error);
    }
}
