import * as fs from 'node:fs';
import * as path from 'node:path';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../core/constants';
import { parseCommandChain, splitCommandLine } from '../../core/command-line';
import { countFileLines, stringSha256, normalizePath, joinOrchestratorPath } from '../shared/helpers';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import {
    readStagedBlobFingerprints,
    type StagedBlobFingerprints
} from '../../core/staged-index-fingerprints';
import {
    buildGitChangeClassificationEvidence,
    classifyGitChanges,
    collectGitChangeClassificationSnapshot,
    deriveGitChangeClassification,
    normalizeGitRepoRelativePath,
    selectGitChangeClassificationLayers,
    type GitChangeClassificationResult,
    type GitChangeClassificationSnapshot,
    type GitChangeLayer
} from '../../core/git-change-classification';
import { isGeneratedOrchestratorLockPath } from '../locks/generated-lock-paths';
import { splitGeneratedRuntimeControlPlaneArtifacts } from '../shared/generated-runtime-artifacts';
import { isOrchestratorSourceCheckout } from '../protected-control-plane/protected-control-plane';
import { getSafeWorktreePathState } from '../workspace/worktree-path-state';
import {
    getSplitCheckpointWorkspaceSnapshot,
    parseSplitCheckpointDetectionSource,
    resolveAuthenticatedSplitCheckpointPreflightScope
} from '../split-required/split-checkpoint-scope';

/**
 * Detect the compile command profile (kind/strategy/label/failure/success profiles).
 * Matches Python get_compile_command_profile exactly.
 */
export function getCompileCommandProfile(command: string) {
    const normalized = (command || '').trim().toLowerCase();
    let kind = 'compile';
    let strategy = 'generic';
    let label = 'compile';

    const testPatterns = [
        /(^|\s)(pytest|nosetests|tox)(\s|$)/,
        /(^|\s)(jest|vitest|ava|mocha)(\s|$)/,
        /(^|\s)(playwright\s+test|cypress\s+run)(\s|$)/,
        /(^|\s)(go\s+test|cargo\s+test|dotnet\s+test)(\s|$)/,
        /(^|\s)(?:\.\/|\.\\)?mvnw(\.cmd)?(\s+.*)?\s+test(\s|$)/,
        /(^|\s)mvn(\s+.*)?\s+test(\s|$)/,
        /(^|\s)(?:\.\/|\.\\)?gradlew(\.bat)?(\s+.*)?\s+test(\s|$)/,
        /(^|\s)gradle(\s+.*)?\s+test(\s|$)/,
        /(^|\s)(npm|pnpm|yarn|bun)(\s+run)?\s+(test(?::[\w:-]+)?|e2e|coverage)(\s|$)/
    ];
    const lintPatterns = [
        /(^|\s)(eslint|stylelint|ruff(\s+check)?|flake8|mypy|pyright|shellcheck|hadolint|ktlint|golangci-lint|phpstan|psalm)(\s|$)/,
        /(^|\s)(npm|pnpm|yarn|bun)(\s+run)?\s+(lint|typecheck|check)(\s|$)/,
        /(^|\s)(cargo\s+clippy|dotnet\s+format|tsc(\s|$).*(--noemit|--no-emit))/
    ];

    if (testPatterns.some(p => p.test(normalized))) {
        kind = 'test'; strategy = 'test'; label = 'test';
    } else if (lintPatterns.some(p => p.test(normalized))) {
        kind = 'lint'; strategy = 'lint'; label = 'lint';
    } else if (/(^|\s)(?:\.\/|\.\\)?mvnw(\.cmd)?(\s|$)/.test(normalized) || /(^|\s)mvn(\s|$)/.test(normalized)) {
        strategy = 'maven'; label = 'maven';
    } else if (/(^|\s)(?:\.\/|\.\\)?gradlew(\.bat)?(\s|$)/.test(normalized) || /(^|\s)gradle(\s|$)/.test(normalized)) {
        strategy = 'gradle'; label = 'gradle';
    } else if (/(^|\s)(npm|pnpm|yarn|bun|npx|vite|webpack|turbo|nx)(\s|$)/.test(normalized)) {
        strategy = 'node'; label = 'node-build';
    } else if (/(^|\s)cargo(\s|$)/.test(normalized)) {
        strategy = 'cargo'; label = 'cargo';
    } else if (/(^|\s)dotnet(\s|$)/.test(normalized)) {
        strategy = 'dotnet'; label = 'dotnet';
    } else if (/(^|\s)go(\s|$)/.test(normalized)) {
        strategy = 'go'; label = 'go';
    }

    let failureProfile, successProfile;
    if (kind === 'test') {
        failureProfile = 'test_failure_console';
        successProfile = 'test_success_console';
    } else if (kind === 'lint') {
        failureProfile = 'lint_failure_console';
        successProfile = 'lint_success_console';
    } else {
        failureProfile = `compile_failure_console_${strategy}`;
        successProfile = 'compile_success_console';
    }

    return { kind, strategy, label, failure_profile: failureProfile, success_profile: successProfile };
}

export interface CompileCommandContractOptions {
    fullSuiteCommand?: string | null;
    allowFullTestCompileCommand?: boolean;
    allowFullTestCompileCommandReason?: string | null;
    allowUnconfiguredSentinel?: boolean;
}

function normalizeCompileCommandForContract(command: string): string {
    return String(command || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function isMavenExecutableToken(token: string): boolean {
    const normalized = path.posix.basename(token);
    return ['mvn', 'mvn.cmd', 'mvnw', 'mvnw.cmd'].includes(normalized);
}

function isGradleExecutableToken(token: string): boolean {
    const normalized = path.posix.basename(token);
    return ['gradle', 'gradle.bat', 'gradlew', 'gradlew.bat'].includes(normalized);
}

const COMPILE_COMMAND_WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'pnx', 'corepack', 'env', 'nice', 'time', 'busybox', 'toybox']);
const PACKAGE_MANAGER_EXECUTABLES = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const TEST_SUBCOMMAND_EXECUTABLES = new Set(['playwright', 'cypress', 'go', 'cargo', 'dotnet']);
const PACKAGE_MANAGER_VALUE_OPTIONS = new Set([
    '--prefix', '--cwd', '--dir', '--filter', '-F', '--workspace', '-w', '--package', '-p', '-c', '-C',
    '--cache', '--registry', '--userconfig', '--node-options'
]);
const NPM_VALUE_OPTIONS = new Set([
    ...[...PACKAGE_MANAGER_VALUE_OPTIONS].filter((option) => !['-p', '-C', '-F'].includes(option)),
    '--call', '--script-shell', '--loglevel'
]);
const NPX_VALUE_OPTIONS = new Set([...NPM_VALUE_OPTIONS, '-p', '--shell']);
const NPM_CALL_SHORT_OPTION = /^-[fglyp]*c$/u;
const PNPM_EXEC_VALUE_OPTIONS = new Set([
    ...[...PACKAGE_MANAGER_VALUE_OPTIONS].filter((option) => !['-c', '-p', '-w'].includes(option)), '--allow-build'
]);
const MAVEN_VALUE_OPTIONS = new Set([
    '-f', '--file', '-s', '--settings', '-gs', '--global-settings', '-t', '--toolchains',
    '-gt', '--global-toolchains', '-l', '--log-file', '-P', '--activate-profiles', '-pl', '--projects',
    '-rf', '--resume-from', '-b', '--builder', '-T', '--threads', '--color', '--metadata-update-policy'
]);
const GRADLE_VALUE_OPTIONS = new Set([
    '-p', '--project-dir', '-g', '--gradle-user-home', '-I', '--init-script', '--project-cache-dir',
    '--include-build', '-b', '--build-file', '-c', '--settings-file', '-D', '--system-prop',
    '-P', '--project-prop', '--console', '--warning-mode', '--max-workers', '--priority', '--update-locks',
    '--configuration-cache-problems', '--configuration-cache-max-problems',
    '-F', '--dependency-verification', '-M', '--write-verification-metadata'
]);
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
    npx: NPX_VALUE_OPTIONS,
    bunx: new Set([...PACKAGE_MANAGER_VALUE_OPTIONS].filter((option) => option !== '-c')),
    pnpx: PNPM_EXEC_VALUE_OPTIONS,
    pnx: PNPM_EXEC_VALUE_OPTIONS,
    env: new Set(['-u', '--unset', '-C', '--chdir', '-a', '--argv0']),
    nice: new Set(['-n', '--adjustment']),
    time: new Set(['-f', '--format', '-o', '--output'])
};

const SHELL_BUILTIN_DISPATCHERS = new Set(['exec', 'command', 'eval', 'source', '.']);
const POSIX_SHELL_EXECUTABLES = new Set(['sh', 'bash', 'dash', 'ash', 'ksh', 'zsh', 'fish', 'csh', 'tcsh', 'nu', 'xonsh']);
const POWERSHELL_VALUE_OPTIONS = new Set([
    '-executionpolicy', '-ex', '-ep', '-inputformat', '-inp', '-if', '-outputformat', '-o', '-of',
    '-workingdirectory', '-wd', '-configurationname', '-config', '-configurationfile', '-custompipename',
    '-settingsfile', '-version', '-v'
]);
const WSL_VALUE_OPTIONS = new Set([
    '-d', '--distribution', '--distribution-id', '-u', '--user', '--cd', '--shell-type'
]);

function wslDelegatedTokens(tokens: readonly string[], start: number): string[] {
    for (let index = start; index < tokens.length; index += 1) {
        const option = tokens[index];
        if (option === '--exec' || option === '-e') {
            const delegated = tokens.slice(index + 1);
            if (delegated[0] && delegated[0] !== '~') return delegated;
            break;
        }
        if (WSL_VALUE_OPTIONS.has(option)) {
            if (!tokens[++index]) break;
        } else if (option !== '--system') {
            break;
        }
    }
    throw new Error('Unsupported WSL execution boundary. Use wsl --exec <program> <args> '
        + 'with supported host options as separate values, or a trusted wrapper script.');
}

function rejectCompileCommandDispatch(executable: string): never {
    throw new Error(`Unsupported executable command dispatch through '${executable}'. `
        + 'Native shell command text and env split-string execution require a trusted wrapper script for compile-gate.');
}

function skipProcessWrapperOptions(tokens: readonly string[], start: number, executable: string): number {
    const valueOptions = WRAPPER_VALUE_OPTIONS[executable];
    let index = start;
    while (index < tokens.length && tokens[index].startsWith('-')) {
        const token = tokens[index++];
        if (token === '--') return index;
        if (token.startsWith('--')) {
            const option = token.split('=')[0];
            if (executable === 'env' && '--split-string'.startsWith(option)) rejectCompileCommandDispatch(executable);
            if (!token.includes('=') && [...valueOptions].some((valueOption) =>
                valueOption.startsWith('--') && valueOption.startsWith(option))) index += 1;
            continue;
        }
        for (let cursor = 1; cursor < token.length; cursor += 1) {
            const option = token[cursor];
            if (executable === 'env' && option === 'S') rejectCompileCommandDispatch(executable);
            if (valueOptions.has('-' + option)) {
                if (cursor === token.length - 1) index += 1;
                break; // The remainder is an attached operand, not more short options.
            }
        }
    }
    return index;
}

function validateCompileCommandDispatch(executable: string, rawArgs: readonly string[]): void {
    if (SHELL_BUILTIN_DISPATCHERS.has(executable)) rejectCompileCommandDispatch(executable);
    if (executable === 'cmd') {
        if (rawArgs.some((arg) => /^\/[ck]/iu.test(arg))) rejectCompileCommandDispatch(executable);
        return;
    }
    const powershell = executable === 'powershell' || executable === 'pwsh';
    if (!powershell && !POSIX_SHELL_EXECUTABLES.has(executable)) return;
    for (let index = 0; index < rawArgs.length; index += 1) {
        const rawOption = rawArgs[index];
        const option = powershell ? rawOption.toLowerCase().replace(/^\//u, '-') : rawOption;
        if (option === '--' || (powershell && ['-file', '-f'].includes(option))) return;
        if (!option.startsWith('-')) return; // The wrapper file owns all following argument data.
        if (powershell) {
            if (['-c', '-cwa', '-e', '-ec'].includes(option)
                || '-command'.startsWith(option) || '-commandwithargs'.startsWith(option)
                || '-encodedcommand'.startsWith(option)) rejectCompileCommandDispatch(executable);
            if ([...POWERSHELL_VALUE_OPTIONS].some((valueOption) => valueOption.startsWith(option))) index += 1;
        } else {
            if (/^-[^-]*c/u.test(option) || /^--commands?(?:=|$)/u.test(option)
                || (executable === 'fish' && (/^-[^-]*C/u.test(option) || /^--init-command(?:=|$)/u.test(option)))) {
                rejectCompileCommandDispatch(executable);
            }
            if (/^-[^-]*[oO]$/u.test(option) || ['--rcfile', '--init-file'].includes(option)) index += 1;
        }
    }
}

function skipCompileCommandOptions(tokens: readonly string[], start: number, valueOptions?: ReadonlySet<string>): number {
    let index = start;
    while (index < tokens.length && tokens[index].startsWith('-')) {
        if (tokens[index] === '--') return index + 1;
        const takesValue = valueOptions?.has(tokens[index])
            || (valueOptions?.has('--call') && NPM_CALL_SHORT_OPTION.test(tokens[index]));
        index += takesValue ? 2 : 1;
    }
    return index;
}

function npmCallCommand(tokens: readonly string[], start: number, npx: boolean): string | undefined {
    let command: string | undefined;
    const valueOptions = npx ? NPX_VALUE_OPTIONS : NPM_VALUE_OPTIONS;
    for (let index = start; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--' || (npx && !token.startsWith('-'))) break;
        const equals = token.indexOf('=');
        const option = equals < 0 ? token : token.slice(0, equals);
        if (option === '--call' || NPM_CALL_SHORT_OPTION.test(option)) {
            command = equals < 0 ? tokens[++index] : token.slice(equals + 1);
        } else if (equals < 0 && valueOptions.has(option)) {
            index += 1;
        }
    }
    return command || undefined;
}

function pnpmShellCommand(tokens: readonly string[], start: number, commandIndex: number, optionsEnd = commandIndex): string | undefined {
    let shellMode = false;
    for (let index = start; index < optionsEnd; index += 1) {
        const token = tokens[index];
        if (token === '--') break;
        if (PNPM_EXEC_VALUE_OPTIONS.has(token)) index += 1;
        else if (token === '--shell-mode' || token === '--shell-mode=true' || /^-[rs]*c[rs]*$/u.test(token)) shellMode = true;
        else if (token === '--shell-mode=false' || token === '--no-shell-mode') shellMode = false;
    }
    return shellMode ? tokens.slice(commandIndex).join(' ') : undefined;
}

function parsePackageRunnerCommand(commandText: string): string[][] {
    // Native shell quote, escape and expansion rules differ from direct argv.
    // Keep an explicit portable subset; direct argv operands retain their literals.
    let withinDoubleQuotes = false;
    let atWordStart = true;
    for (const character of commandText) {
        if (character === '"') withinDoubleQuotes = !withinDoubleQuotes;
        if ("$`%!^\\*?[]{}~'\r\n".includes(character)
            || (!withinDoubleQuotes && ('()'.includes(character) || (character === '#' && atWordStart)))) {
            throw new Error('Unsupported executable command-string syntax ' + JSON.stringify(character)
                + '. Shell expansion, native escaping, single-quote syntax, unquoted grouping and shell comments require a trusted wrapper script.');
        }
        atWordStart = !withinDoubleQuotes && ' \t&'.includes(character);
    }
    return parseCommandChain(commandText);
}

function compileCommandParts(tokens: readonly string[], rawTokens: readonly string[] = tokens): {
    executableIndex: number; executableIndexes: number[]; executable: string; args: string[]; rawArgs: string[];
    commandText?: string; delegatedTokens?: string[]
} {
    let executableIndex = 0;
    const executableIndexes: number[] = [];
    while (executableIndex < tokens.length) {
        executableIndexes.push(executableIndex);
        const executableToken = path.posix.basename(tokens[executableIndex]).replace(/\.(?:cmd|exe)$/u, '');
        const executable = executableToken === 'yarnpkg' ? 'yarn' : executableToken === 'pn' ? 'pnpm' : executableToken;
        let argumentIndex = executableIndex + 1;
        validateCompileCommandDispatch(executable, rawTokens.slice(argumentIndex));
        if (executable === 'wsl') {
            return { executableIndex, executableIndexes, executable, args: [], rawArgs: [],
                delegatedTokens: wslDelegatedTokens(rawTokens, argumentIndex) };
        } else if (PACKAGE_MANAGER_EXECUTABLES.has(executable)) {
            const valueOptions = executable === 'npm' ? NPM_VALUE_OPTIONS
                : executable === 'pnpm' ? PNPM_EXEC_VALUE_OPTIONS : PACKAGE_MANAGER_VALUE_OPTIONS;
            argumentIndex = skipCompileCommandOptions(rawTokens, argumentIndex, valueOptions);
            const delegatesExecutable = ['exec', 'dlx'].includes(tokens[argumentIndex])
                || (['npm', 'bun'].includes(executable) && tokens[argumentIndex] === 'x');
            if (!delegatesExecutable) {
                return { executableIndex, executableIndexes, executable, args: tokens.slice(argumentIndex), rawArgs: rawTokens.slice(argumentIndex) };
            }
            const delegatedIndex = skipCompileCommandOptions(rawTokens, argumentIndex + 1,
                executable === 'pnpm' ? PNPM_EXEC_VALUE_OPTIONS : valueOptions);
            const commandText = executable === 'npm' ? npmCallCommand(rawTokens, executableIndex + 1, false)
                : executable === 'pnpm' ? pnpmShellCommand(rawTokens, executableIndex + 1, delegatedIndex,
                    tokens[argumentIndex] === 'exec' ? argumentIndex : delegatedIndex) : undefined;
            if (commandText !== undefined) return { executableIndex: tokens.length, executableIndexes, executable: '', args: [], rawArgs: [], commandText };
            executableIndex = delegatedIndex;
        } else if (COMPILE_COMMAND_WRAPPERS.has(executable)) {
            argumentIndex = ['env', 'nice', 'time'].includes(executable) ? skipProcessWrapperOptions(rawTokens, argumentIndex, executable)
                : skipCompileCommandOptions(rawTokens, argumentIndex, WRAPPER_VALUE_OPTIONS[executable]);
            const commandText = executable === 'npx' ? npmCallCommand(rawTokens, executableIndex + 1, true)
                : ['pnpx', 'pnx'].includes(executable) ? pnpmShellCommand(rawTokens, executableIndex + 1, argumentIndex) : undefined;
            if (commandText !== undefined) return { executableIndex: tokens.length, executableIndexes, executable: '', args: [], rawArgs: [], commandText };
            while (executable === 'env' && /^[a-z_][a-z0-9_]*=/u.test(tokens[argumentIndex] || '')) argumentIndex += 1;
            executableIndex = argumentIndex;
        } else {
            return { executableIndex, executableIndexes, executable, args: tokens.slice(argumentIndex), rawArgs: rawTokens.slice(argumentIndex) };
        }
    }
    return { executableIndex, executableIndexes, executable: '', args: [], rawArgs: [] };
}

function findCompileToolExecutableIndex(
    tokens: readonly string[], matches: (token: string) => boolean, rawTokens: readonly string[] = tokens
): number {
    const { executableIndex } = compileCommandParts(tokens, rawTokens);
    return executableIndex < tokens.length && matches(tokens[executableIndex]) ? executableIndex : -1;
}

function hasMavenSkipTestsFlag(tokens: readonly string[]): boolean {
    let skipTests = false;
    let skipAllTests = false;
    for (const token of tokens) {
        const property = /^-D(skipTests|maven\.test\.skip)(?:=(.*))?$/u.exec(token);
        if (!property) continue;
        const enabled = property[2] === undefined || property[2].toLowerCase() === 'true';
        if (property[1] === 'skipTests') skipTests = enabled;
        else skipAllTests = enabled;
    }
    return skipTests || skipAllTests;
}

function getMavenLifecycleViolation(tokens: readonly string[], rawTokens: readonly string[]): string | null {
    const executableIndex = findCompileToolExecutableIndex(tokens, isMavenExecutableToken, rawTokens);
    if (executableIndex < 0) {
        return null;
    }
    const testBoundPhases = new Set(['test', 'package', 'verify', 'install', 'deploy']);
    const contractTokens: string[] = [];
    for (let index = executableIndex + 1; index < tokens.length; index += 1) {
        const token = rawTokens[index];
        if (token === '-D' || token === '--define') contractTokens.push('-D' + (rawTokens[++index] || ''));
        else if (MAVEN_VALUE_OPTIONS.has(token)) index += 1;
        else contractTokens.push(token.startsWith('--define=') ? '-D' + token.slice('--define='.length) : token);
    }
    const skipTests = hasMavenSkipTestsFlag(contractTokens);
    const violatingGoal = contractTokens.find((goal) => testBoundPhases.has(goal.toLowerCase()) && (goal.toLowerCase() === 'test' || !skipTests));
    if (!violatingGoal) {
        return null;
    }
    return `Maven phase '${violatingGoal}' is test-bound; use 'compile' or 'test-compile' for compile-gate, or move this command to full-suite validation.`;
}

function hasGradleExcludedTestTask(tokens: readonly string[]): boolean {
    return getGradleExcludedTestTasks(tokens).length > 0;
}

function getGradleTaskName(token: string): string {
    return token.split(':').filter(Boolean).pop() || token;
}

function getGradleProjectPath(token: string): string {
    const normalized = String(token || '').trim();
    if (!normalized.includes(':')) {
        return '';
    }
    const lastColonIndex = normalized.lastIndexOf(':');
    return lastColonIndex > 0 ? normalized.slice(0, lastColonIndex) : '';
}

function getGradleExcludedTestTasks(tokens: readonly string[]): string[] {
    const excludedTasks: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (GRADLE_VALUE_OPTIONS.has(token)) {
            index += 1;
            continue;
        }
        let excludedTask: string | null = null;
        if (token === '-x' || token === '--exclude-task') {
            excludedTask = tokens[++index] || null;
        } else if (token.startsWith('--exclude-task=')) {
            excludedTask = token.slice('--exclude-task='.length);
        }
        excludedTask = excludedTask?.replace(/\\/g, '/').toLowerCase() || null;
        if (excludedTask && getGradleTaskName(excludedTask) === 'test') {
            excludedTasks.push(excludedTask);
        }
    }
    return excludedTasks;
}

function isGradleBuildTaskTestExcluded(buildTask: string, excludedTestTasks: readonly string[]): boolean {
    if (excludedTestTasks.includes('test')) {
        return true;
    }
    const projectPath = getGradleProjectPath(buildTask);
    return projectPath !== '' && excludedTestTasks.some((excludedTask) => (
        getGradleTaskName(excludedTask) === 'test'
        && getGradleProjectPath(excludedTask) === projectPath
    ));
}

function getGradleTaskTokensForContract(tokens: readonly string[], executableIndex: number): string[] {
    const tasks: string[] = [];
    const rawTokens = tokens.slice(executableIndex + 1);
    for (let index = 0; index < rawTokens.length; index += 1) {
        const token = rawTokens[index];
        if (GRADLE_VALUE_OPTIONS.has(token) || token === '-x' || token === '--exclude-task') {
            index += 1;
            continue;
        }
        if (token.startsWith('--exclude-task=')) {
            continue;
        }
        if (token.startsWith('-')) {
            continue;
        }
        tasks.push(token.replace(/\\/g, '/').toLowerCase());
    }
    return tasks;
}

function isGradleTestTokenOnlyExcluded(tokens: readonly string[], rawTokens: readonly string[]): boolean {
    const executableIndex = findCompileToolExecutableIndex(tokens, isGradleExecutableToken, rawTokens);
    if (executableIndex < 0 || !hasGradleExcludedTestTask(rawTokens.slice(executableIndex + 1))) {
        return false;
    }
    return !getGradleTaskTokensForContract(rawTokens, executableIndex)
        .map(getGradleTaskName)
        .includes('test');
}

function getGradleLifecycleViolation(tokens: readonly string[], rawTokens: readonly string[]): string | null {
    const executableIndex = findCompileToolExecutableIndex(tokens, isGradleExecutableToken, rawTokens);
    if (executableIndex < 0) {
        return null;
    }
    const taskTokens = getGradleTaskTokensForContract(rawTokens, executableIndex);
    const taskNames = taskTokens.map(getGradleTaskName);
    if (taskNames.includes('test')) {
        return "Gradle task 'test' runs tests; use 'assemble', 'classes', or 'testClasses' for compile-gate, or move this command to full-suite validation.";
    }
    if (taskNames.includes('check')) {
        return "Gradle task 'check' is a verification lifecycle task; use 'assemble', 'classes', or 'testClasses' for compile-gate, or move this command to full-suite validation.";
    }
    const excludedTestTasks = getGradleExcludedTestTasks(rawTokens.slice(executableIndex + 1));
    const buildTasks = taskTokens.filter((task) => getGradleTaskName(task) === 'build');
    const hasUnexcludedBuildTask = buildTasks.some((task) => !isGradleBuildTaskTestExcluded(task, excludedTestTasks));
    if (hasUnexcludedBuildTask) {
        return "Gradle task 'build' normally depends on test/check tasks; use 'assemble', 'classes', or 'build -x test' for compile-gate, or move this command to full-suite validation.";
    }
    return null;
}

export function getCompileCommandContractViolations(
    command: string,
    options: CompileCommandContractOptions = {}
): string[] {
    const trimmedCommand = String(command || '').trim();
    if (!trimmedCommand) return [];
    const commands = parseCommandChain(command);
    const violations: string[] = [];
    const configuredFullSuiteCommand = normalizeCompileCommandForContract(options.fullSuiteCommand || '');
    const configuredFullSuiteTokens = splitCommandLine(options.fullSuiteCommand || '')
        .map((token) => token.replace(/\\/g, '/').toLowerCase());
    if (configuredFullSuiteCommand && normalizeCompileCommandForContract(trimmedCommand) === configuredFullSuiteCommand) {
        violations.push('matches the configured full-suite validation command');
    }
    for (const commandTokens of commands) {
        const tokens = commandTokens.map((token) => token.replace(/\\/g, '/').toLowerCase());
        if (configuredFullSuiteTokens.length && JSON.stringify(tokens) === JSON.stringify(configuredFullSuiteTokens)) {
            violations.push('matches the configured full-suite validation command');
        }
        const { executableIndexes, commandText, delegatedTokens } = compileCommandParts(tokens, commandTokens);
        if (configuredFullSuiteTokens.length && executableIndexes.some((index) => index > 0
            && JSON.stringify(tokens.slice(index)) === JSON.stringify(configuredFullSuiteTokens))) {
            violations.push('matches the configured full-suite validation command');
        }
        if (delegatedTokens) {
            // WSL --exec delegates argv, not executable shell text; never join or reparse its data.
            commands.push(delegatedTokens);
            continue;
        }
        if (commandText !== undefined) {
            // These operands are executable text; ordinary argv values remain data.
            for (const delegated of parsePackageRunnerCommand(commandText)) commands.push(delegated);
            continue;
        }
        const profile = getCompileCommandProfile(compileProfileCommand(tokens, commandTokens));
        if (profile.kind === 'test' && findCompileToolExecutableIndex(tokens, isMavenExecutableToken, commandTokens) < 0
            && !isGradleTestTokenOnlyExcluded(tokens, commandTokens)) {
            violations.push('is classified as a test command');
        }
        const mavenViolation = getMavenLifecycleViolation(tokens, commandTokens);
        if (mavenViolation) violations.push(mavenViolation);
        const gradleViolation = getGradleLifecycleViolation(tokens, commandTokens);
        if (gradleViolation) violations.push(gradleViolation);
    }
    return [...new Set(violations)];
}

function compileProfileCommand(tokens: readonly string[], rawTokens: readonly string[]): string {
    const { executable, args, rawArgs } = compileCommandParts(tokens, rawTokens);
    let commandArgs: string[] = [];
    if (PACKAGE_MANAGER_EXECUTABLES.has(executable)) {
        const valueOptions = executable === 'npm' ? NPM_VALUE_OPTIONS
            : executable === 'pnpm' ? PNPM_EXEC_VALUE_OPTIONS : PACKAGE_MANAGER_VALUE_OPTIONS;
        const scriptIndex = skipCompileCommandOptions(rawArgs, 1, valueOptions);
        commandArgs = args[0] === 'run' ? [args[0], args[scriptIndex] || ''] : args.slice(0, 1);
    } else if (TEST_SUBCOMMAND_EXECUTABLES.has(executable)) {
        commandArgs = args.slice(0, 1);
    } else if (/^(?:python(?:\d+(?:\.\d+)*)?|py)$/u.test(executable)) {
        commandArgs = pythonModuleArguments(rawArgs);
    }
    return [executable, ...commandArgs].map(compileProfileArgument).join(' ');
}

function pythonModuleArguments(args: readonly string[]): string[] {
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === '-' || token === '--' || !token.startsWith('-')) return [];
        if (token === '--check-hash-based-pycs') {
            index += 1;
            continue;
        }
        const argumentOption = /^-[bBdEhiIOPqRsSuvVx]*([cmWX])(.*)$/u.exec(token);
        if (!argumentOption) continue;
        if (argumentOption[1] === 'c') return [];
        if (argumentOption[1] === 'm') return ['-m', argumentOption[2] || args[index + 1] || ''];
        if (!argumentOption[2]) index += 1;
    }
    return [];
}

function compileProfileArgument(token: string): string {
    if (!/\s/u.test(token)) return token;
    // Profiling must not treat whitespace inside one argv value as command separators.
    return JSON.stringify(token).replace(/\s/gu, (character) => (
        '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
    ));
}

function validateCompileCommandContract(
    command: string,
    rulePath: string,
    options: CompileCommandContractOptions
): void {
    const violations = getCompileCommandContractViolations(command, options);
    if (violations.length === 0) {
        return;
    }
    if (options.allowFullTestCompileCommand === true && String(options.allowFullTestCompileCommandReason || '').trim()) {
        return;
    }
    throw new Error(
        `Compile command must not run the full test suite in ${rulePath}: ${command}. `
        + `Reason: ${violations.join(' ')}. `
        + 'Use a compile/build/type-check command for compile-gate and keep test suites under full-suite-validation. '
        + 'If this repository has no separate compile command, rerun with --allow-full-test-compile-command and --allow-full-test-compile-command-reason after explicit operator approval.'
    );
}

export function validateCompileGateCommand(
    command: string,
    sourceLabel: string,
    options: CompileCommandContractOptions = {}
): void {
    const trimmedCommand = String(command || '').trim();
    if (!trimmedCommand) {
        throw new Error(`Compile command is missing in ${sourceLabel}.`);
    }
    if (trimmedCommand === UNCONFIGURED_COMPILE_GATE_COMMAND) {
        if (options.allowUnconfiguredSentinel) {
            return;
        }
        throw new Error(`Compile command is unconfigured in ${sourceLabel}: ${UNCONFIGURED_COMPILE_GATE_COMMAND}`);
    }
    if (/^\s*<[^>]+>\s*$/.test(trimmedCommand)) {
        throw new Error(`Compile command placeholder is unresolved in ${sourceLabel}: ${trimmedCommand}`);
    }
    if (/\borg\.apache\.maven\.wrapper\.mavenwrappermain\b/i.test(trimmedCommand)) {
        throw new Error(
            `Compile command anti-pattern detected in ${sourceLabel}: ` +
            "use wrapper entrypoint script (for example './mvnw' or '.\\mvnw.cmd') instead of MavenWrapperMain class invocation."
        );
    }
    parseCommandChain(command);
    validateCompileCommandContract(trimmedCommand, sourceLabel, options);
}

/**
 * Extract compile commands from a markdown rules file.
 * Matches Python get_compile_commands.
 */
export function getCompileCommands(rulePath: string, options: CompileCommandContractOptions = {}): string[] {
    const content = fs.readFileSync(rulePath, 'utf8');
    const lines = content.split(/\r?\n/);
    if (!lines.length) throw new Error(`Commands file is empty: ${rulePath}`);

    let sectionIndex = -1;
    for (let idx = 0; idx < lines.length; idx++) {
        if (lines[idx].trim() === '### Compile Gate (Mandatory)') {
            sectionIndex = idx;
            break;
        }
    }
    if (sectionIndex < 0) throw new Error(`Section '### Compile Gate (Mandatory)' not found in ${rulePath}`);

    let fenceStart = -1;
    for (let idx = sectionIndex + 1; idx < lines.length; idx++) {
        const stripped = lines[idx].trim();
        if (stripped.startsWith('```')) { fenceStart = idx; break; }
        if (stripped.startsWith('### ')) break;
    }
    if (fenceStart < 0) {
        throw new Error(`Code fence with compile command not found under '### Compile Gate (Mandatory)' in ${rulePath}`);
    }

    const commands = [];
    for (let idx = fenceStart + 1; idx < lines.length; idx++) {
        const stripped = lines[idx].trim();
        if (stripped.startsWith('```')) break;
        if (!stripped || stripped.startsWith('#')) continue;
        commands.push(stripped);
    }

    if (!commands.length) {
        throw new Error(`Compile command is missing under '### Compile Gate (Mandatory)' in ${rulePath}`);
    }

    for (const command of commands) {
        validateCompileGateCommand(command, rulePath, options);
    }

    return commands;
}

/**
 * Get output stats (warning and error line counts).
 */
export function getOutputStats(lines: string[]) {
    let warningLines = 0;
    let errorLines = 0;
    for (const line of lines) {
        if (/\bwarning\b/i.test(line)) warningLines++;
        if (/\berror\b/i.test(line)) errorLines++;
    }
    return { warningLines, errorLines };
}

/**
 * Extract the "new" file path from a numstat path-spec column.
 * Handles rename syntax: "old => new" and "{old => new}/suffix".
 */
export function extractNewPathFromNumstat(pathSpec: string): string {
    if (!pathSpec.includes(' => ')) return pathSpec;

    // Brace-style: "prefix/{old => new}/suffix" or "{old => new}"
    const braceMatch = pathSpec.match(/^(.*?)\{[^}]* => ([^}]*)\}(.*)$/);
    if (braceMatch) {
        return braceMatch[1] + braceMatch[2] + braceMatch[3];
    }

    // Simple style: "old => new"
    const arrowIndex = pathSpec.indexOf(' => ');
    return pathSpec.substring(arrowIndex + 4);
}

function getWorktreeContentFingerprint(repoRoot: string, relativePath: string): string {
    const normalized = normalizePath(relativePath);
    if (!normalized) {
        return 'missing';
    }
    const state = getSafeWorktreePathState(repoRoot, normalized);
    switch (state.status) {
        case 'file':
            return `worktree:file:${state.size ?? 0}:${state.sha256 || 'UNHASHABLE'}`;
        case 'directory':
            return 'worktree:dir';
        case 'symbolic_link':
            return [
                'worktree:symlink',
                state.size ?? 0,
                state.link_sha256 || 'UNHASHABLE',
                state.target_status || 'unknown',
                state.target_path || '',
                state.target_mode ?? 0,
                state.target_size ?? 0,
                state.target_sha256 || 'UNHASHABLE'
            ].join(':');
        case 'unreviewable_symlink':
            return [
                'worktree:unreviewable_symlink',
                state.size ?? 0,
                state.link_sha256 || 'UNHASHABLE',
                state.target_status || 'unknown',
                state.target_path || '',
                state.target_mode ?? 0,
                state.target_size ?? 0
            ].join(':');
        case 'outside_repo':
            return 'outside_repo';
        case 'special':
            return 'worktree:other';
        case 'missing':
        default:
            return 'missing';
    }
}

export function buildScopeContentFingerprint(
    repoRoot: string,
    source: string,
    changedFiles: string[],
    stagedBlobFingerprints?: StagedBlobFingerprints
): string | null {
    if (parseSplitCheckpointDetectionSource(source)) {
        if (changedFiles.length === 0) {
            return stringSha256('');
        }
        return getSplitCheckpointWorkspaceSnapshot(repoRoot, source, changedFiles).scope_content_sha256;
    }
    const useStaged = ['git_staged_only', 'git_staged_plus_untracked'].includes(source);
    const normalizedChangedFiles = [...new Set(changedFiles.map((entry) => normalizePath(entry)).filter(Boolean))]
        .sort();
    const resolvedStagedBlobFingerprints = useStaged
        ? stagedBlobFingerprints || readStagedBlobFingerprints(repoRoot, normalizedChangedFiles)
        : undefined;
    const fingerprintEntries = normalizedChangedFiles
        .map((relativePath) => {
            const stagedFingerprint = useStaged
                ? resolvedStagedBlobFingerprints?.get(relativePath) || null
                : null;
            return `${relativePath}:${stagedFingerprint || getWorktreeContentFingerprint(repoRoot, relativePath)}`;
        });
    return stringSha256(fingerprintEntries.join('\n'));
}

export interface WorkspaceSnapshotGitGeneration {
    readonly repo_root: string;
    readClassification(explicitUntrackedPaths: readonly string[]): GitChangeClassificationResult;
    readNumstat(useStaged: boolean): readonly string[];
    readStagedBlobFingerprints(relativePaths: readonly string[]): StagedBlobFingerprints;
}

const workspaceSnapshotGitGenerations = new WeakSet<WorkspaceSnapshotGitGeneration>();

function runWorkspaceSnapshotGitLines(repoRoot: string, args: string[], failMsg: string): string[] {
    const result = spawnSyncWithTimeout('git', ['-C', String(repoRoot), ...args], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024
    });
    if (result.timedOut) {
        throw new Error(`${failMsg} git timed out after ${DEFAULT_GIT_TIMEOUT_MS} ms.`);
    }
    if (result.error) {
        throw new Error(`${failMsg} ${result.error.message || result.error}`);
    }
    if (result.status !== 0) {
        const errText = String(result.stderr || '').trim();
        throw new Error(`${failMsg} git exited with code ${result.status}. ${errText}`);
    }
    return String(result.stdout || '').split(/\r?\n/).filter((line) => line.trim());
}

function normalizeGenerationPaths(relativePaths: readonly string[]): string[] {
    return [...new Set(
        relativePaths
            .map((filePath) => normalizeGitRepoRelativePath(filePath))
            .filter((filePath): filePath is string => filePath !== null)
    )].sort();
}

export function createWorkspaceSnapshotGitGeneration(repoRoot: string): WorkspaceSnapshotGitGeneration {
    const resolvedRepoRoot = path.resolve(repoRoot);
    let classificationSnapshot: GitChangeClassificationSnapshot | null = null;
    const classifications = new Map<string, GitChangeClassificationResult>();
    const numstatByTarget = new Map<boolean, readonly string[]>();

    function readClassificationSnapshot(): GitChangeClassificationSnapshot {
        classificationSnapshot ??= collectGitChangeClassificationSnapshot(resolvedRepoRoot, {
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        });
        return classificationSnapshot;
    }

    const generation = Object.freeze({
        repo_root: normalizePath(resolvedRepoRoot),
        readClassification(explicitUntrackedPaths: readonly string[]): GitChangeClassificationResult {
            const normalizedPaths = normalizeGenerationPaths(explicitUntrackedPaths);
            const key = normalizedPaths.join('\0');
            const cached = classifications.get(key);
            if (cached) return cached;
            const classification = deriveGitChangeClassification(
                resolvedRepoRoot,
                readClassificationSnapshot(),
                normalizedPaths
            );
            classifications.set(key, classification);
            return classification;
        },
        readNumstat(useStaged: boolean): readonly string[] {
            const cached = numstatByTarget.get(useStaged);
            if (cached) return cached;
            const args = ['diff', '--numstat', '--diff-filter=ACDMRTUXB', useStaged ? '--cached' : 'HEAD'];
            const rows = Object.freeze(runWorkspaceSnapshotGitLines(
                resolvedRepoRoot,
                args,
                'Failed to collect changed files snapshot.'
            ));
            numstatByTarget.set(useStaged, rows);
            return rows;
        },
        readStagedBlobFingerprints(relativePaths: readonly string[]): StagedBlobFingerprints {
            const snapshot = readClassificationSnapshot();
            const fingerprints = new Map<string, string>();
            for (const relativePath of normalizeGenerationPaths(relativePaths)) {
                const fingerprint = snapshot.stagedBlobFingerprints.get(relativePath);
                if (fingerprint) fingerprints.set(relativePath, fingerprint);
            }
            return fingerprints;
        }
    });
    workspaceSnapshotGitGenerations.add(generation);
    return generation;
}

function authenticateWorkspaceSnapshotGitGeneration(
    repoRoot: string,
    generation?: WorkspaceSnapshotGitGeneration
): WorkspaceSnapshotGitGeneration | null {
    if (!generation) return null;
    if (
        !workspaceSnapshotGitGenerations.has(generation)
        || path.resolve(generation.repo_root) !== path.resolve(repoRoot)
    ) {
        throw new Error('Workspace Git generation is not factory-authenticated for the requested repository root.');
    }
    return generation;
}

/**
 * Get workspace snapshot for scope validation.
 * Matches Python get_workspace_snapshot.
 */
export function getWorkspaceSnapshot(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[],
    gitGeneration?: WorkspaceSnapshotGitGeneration
) {
    const authenticatedGitGeneration = authenticateWorkspaceSnapshotGitGeneration(repoRoot, gitGeneration);
    const source = (detectionSource || 'git_auto').trim().toLowerCase();
    if (parseSplitCheckpointDetectionSource(source)) {
        const snapshot = getSplitCheckpointWorkspaceSnapshot(repoRoot, source, explicitChangedFiles);
        return {
            ...snapshot,
            git_change_classification: null,
            authorized_files: snapshot.changed_files,
            authorized_files_count: snapshot.changed_files_count,
            authorized_files_sha256: snapshot.changed_files_sha256
        };
    }
    const useStaged = ['git_staged_only', 'git_staged_plus_untracked'].includes(source);
    if (source === 'git_staged_only') includeUntracked = false;
    const snapshotCacheRelativePath = normalizePath(
        path.relative(repoRoot, joinOrchestratorPath(repoRoot, path.join('runtime', 'cache', 'workspace-snapshot.json')))
    );
    function isInternalSnapshotCachePath(relativePath: string): boolean {
        const normalized = normalizePath(relativePath);
        return !!normalized && normalized === snapshotCacheRelativePath;
    }
    function isIgnoredWorkspaceSnapshotPath(relativePath: string): boolean {
        return isInternalSnapshotCachePath(relativePath) || isGeneratedOrchestratorLockPath(relativePath);
    }
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    const generatedRuntimeSplitOptions = { isSourceCheckout };

    const rawExplicitSplit = splitGeneratedRuntimeControlPlaneArtifacts(
        (explicitChangedFiles || []).map((filePath) => {
            const normalizedPath = normalizePath(filePath);
            return normalizedPath ? path.posix.normalize(normalizedPath) : '';
        }),
        generatedRuntimeSplitOptions
    );
    const allNormalizedExplicit = [...new Set(
        rawExplicitSplit.reviewableFiles
            .map((f: string) => normalizeGitRepoRelativePath(f))
            .filter((f): f is string => f !== null)
    )]
        .filter((item: string) => !isIgnoredWorkspaceSnapshotPath(item))
        .sort();
    const explicitSplit = splitGeneratedRuntimeControlPlaneArtifacts(allNormalizedExplicit, generatedRuntimeSplitOptions);
    const normalizedExplicit = explicitSplit.reviewableFiles;
    const ignoredGeneratedRuntimeFiles = [
        ...rawExplicitSplit.ignoredGeneratedRuntimeFiles,
        ...explicitSplit.ignoredGeneratedRuntimeFiles
    ];
    const changedFileStats: Record<string, { additions: number; deletions: number; changed_lines: number }> = {};

    if (source === 'explicit_changed_files') {
        const selectedGitLayers: GitChangeLayer[] = [
            'staged',
            'unstaged',
            ...(includeUntracked ? ['untracked' as const] : [])
        ];
        const explicitUntrackedPaths = includeUntracked ? normalizedExplicit : [];
        const completeGitClassification = authenticatedGitGeneration
            ? authenticatedGitGeneration.readClassification(explicitUntrackedPaths)
            : classifyGitChanges(repoRoot, {
                timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
                explicitUntrackedPaths
            });
        const explicitLayerClassification = selectGitChangeClassificationLayers(completeGitClassification, {
            layers: selectedGitLayers,
            paths: normalizedExplicit,
            context: `workspace snapshot detection_source=${source}`
        });
        const canonicalSplit = splitGeneratedRuntimeControlPlaneArtifacts(
            explicitLayerClassification.effectiveChangedFiles
                .filter((item) => !isIgnoredWorkspaceSnapshotPath(item)),
            generatedRuntimeSplitOptions
        );
        ignoredGeneratedRuntimeFiles.push(...canonicalSplit.ignoredGeneratedRuntimeFiles);
        const normalizedChanged = [...new Set(canonicalSplit.reviewableFiles)].sort();
        const normalizedChangedSet = new Set(normalizedChanged);
        const gitChangeClassification = selectGitChangeClassificationLayers(completeGitClassification, {
            layers: selectedGitLayers,
            paths: normalizedChanged,
            context: `workspace snapshot detection_source=${source}`
        });

        let additionsTotal = 0, deletionsTotal = 0;
        if (normalizedExplicit.length > 0) {
            const numstatLines = authenticatedGitGeneration
                ? authenticatedGitGeneration.readNumstat(false)
                : runWorkspaceSnapshotGitLines(
                    repoRoot,
                    ['diff', '--numstat', '--diff-filter=ACDMRTUXB', 'HEAD', '--', ...normalizedExplicit],
                    'Failed numstat'
                );
            for (const line of numstatLines) {
                const parts = line.split('\t');
                if (parts.length >= 3) {
                    const changedPath = normalizePath(extractNewPathFromNumstat(parts.slice(2).join('\t')));
                    if (!changedPath || isIgnoredWorkspaceSnapshotPath(changedPath)) continue;
                    if (!normalizedChangedSet.has(changedPath)) continue;
                    const additions = /^\d+$/.test(parts[0]) ? parseInt(parts[0], 10) : 0;
                    const deletions = /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 0;
                    additionsTotal += additions;
                    deletionsTotal += deletions;
                    changedFileStats[changedPath] = {
                        additions,
                        deletions,
                        changed_lines: additions + deletions
                    };
                }
            }
        }

        if (includeUntracked) {
            for (const item of gitChangeClassification.untrackedFiles) {
                const additions = countWorktreeFileLines(repoRoot, item);
                additionsTotal += additions;
                changedFileStats[item] = {
                    additions,
                    deletions: 0,
                    changed_lines: additions
                };
            }
        }
        for (const item of normalizedChanged) {
            changedFileStats[item] ??= { additions: 0, deletions: 0, changed_lines: 0 };
        }

        const changedLinesTotal = additionsTotal + deletionsTotal;
        const filesFingerprint = stringSha256(normalizedChanged.join('\n'));
        const authorizedFilesFingerprint = stringSha256(normalizedExplicit.join('\n'));
        const contentFingerprint = buildScopeContentFingerprint(repoRoot, source, normalizedChanged);
        const scopeFingerprint = stringSha256(
            `${source}|false|${includeUntracked}|${normalizedExplicit.length}|${authorizedFilesFingerprint}|` +
            `${normalizedChanged.length}|${changedLinesTotal}|${filesFingerprint}|${contentFingerprint}`
        );

        return {
            detection_source: source, use_staged: false, include_untracked: !!includeUntracked,
            git_change_classification: buildGitChangeClassificationEvidence(gitChangeClassification),
            authorized_files: normalizedExplicit,
            authorized_files_count: normalizedExplicit.length,
            authorized_files_sha256: authorizedFilesFingerprint,
            changed_files: normalizedChanged, changed_files_count: normalizedChanged.length,
            ignored_generated_runtime_files: [...new Set(ignoredGeneratedRuntimeFiles)].sort(),
            ignored_generated_runtime_files_count: new Set(ignoredGeneratedRuntimeFiles).size,
            additions_total: additionsTotal, deletions_total: deletionsTotal,
            changed_lines_total: changedLinesTotal,
            changed_file_stats: changedFileStats,
            changed_files_sha256: filesFingerprint,
            scope_content_sha256: contentFingerprint,
            scope_sha256: scopeFingerprint
        };
    }

    const selectedGitLayers: GitChangeLayer[] = useStaged
        ? ['staged', ...(includeUntracked ? ['untracked' as const] : [])]
        : ['staged', 'unstaged', ...(includeUntracked ? ['untracked' as const] : [])];
    const completeGitClassification = authenticatedGitGeneration
        ? authenticatedGitGeneration.readClassification([])
        : classifyGitChanges(repoRoot, {
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        });
    const layerClassification = selectGitChangeClassificationLayers(completeGitClassification, {
        layers: selectedGitLayers,
        context: `workspace snapshot detection_source=${source}`
    });
    const canonicalCandidates = layerClassification.effectiveChangedFiles
        .filter((item) => !isIgnoredWorkspaceSnapshotPath(item));
    const canonicalSplit = splitGeneratedRuntimeControlPlaneArtifacts(
        canonicalCandidates,
        generatedRuntimeSplitOptions
    );
    ignoredGeneratedRuntimeFiles.push(...canonicalSplit.ignoredGeneratedRuntimeFiles);
    const normalizedChanged = [...new Set(canonicalSplit.reviewableFiles)].sort();
    const normalizedChangedSet = new Set(normalizedChanged);
    const gitChangeClassification = selectGitChangeClassificationLayers(completeGitClassification, {
        layers: selectedGitLayers,
        paths: normalizedChanged,
        context: `workspace snapshot detection_source=${source}`
    });

    const diffArgs = ['diff', '--numstat', '--diff-filter=ACDMRTUXB'];
    diffArgs.push(useStaged ? '--cached' : 'HEAD');
    const numstatOutput = authenticatedGitGeneration
        ? authenticatedGitGeneration.readNumstat(useStaged)
        : runWorkspaceSnapshotGitLines(repoRoot, diffArgs, 'Failed to collect changed files snapshot.');

    // Extract both file names and line counts from the single numstat call
    const diffFileStats: Record<string, { additions: number; deletions: number; changed_lines: number }> = {};
    let additionsTotal = 0, deletionsTotal = 0;
    for (const row of numstatOutput) {
        const parts = row.split('\t');
        if (parts.length < 3) continue;
        const filePath = extractNewPathFromNumstat(parts.slice(2).join('\t'));
        const normalizedFilePath = normalizePath(filePath);
        if (!normalizedFilePath || isIgnoredWorkspaceSnapshotPath(normalizedFilePath)) continue;
        if (!normalizedChangedSet.has(normalizedFilePath)) continue;
        const additions = /^\d+$/.test(parts[0]) ? parseInt(parts[0], 10) : 0;
        const deletions = /^\d+$/.test(parts[1]) ? parseInt(parts[1], 10) : 0;
        additionsTotal += additions;
        deletionsTotal += deletions;
        diffFileStats[normalizedFilePath] = {
            additions,
            deletions,
            changed_lines: additions + deletions
        };
    }

    if (includeUntracked) {
        for (const item of gitChangeClassification.untrackedFiles) {
            const additions = countWorktreeFileLines(repoRoot, item);
            additionsTotal += additions;
            diffFileStats[item] = {
                additions,
                deletions: 0,
                changed_lines: additions
            };
        }
    }
    for (const item of normalizedChanged) {
        diffFileStats[item] ??= { additions: 0, deletions: 0, changed_lines: 0 };
    }

    const changedLinesTotal = additionsTotal + deletionsTotal;
    const filesFingerprint = stringSha256(normalizedChanged.join('\n'));
    const contentFingerprint = buildScopeContentFingerprint(
        repoRoot,
        source,
        normalizedChanged,
        useStaged
            ? authenticatedGitGeneration?.readStagedBlobFingerprints(normalizedChanged)
            : undefined
    );
    const scopeFingerprint = stringSha256(
        `${source}|${useStaged}|${includeUntracked}|${normalizedChanged.length}|${changedLinesTotal}|${filesFingerprint}|${contentFingerprint}`
    );

    return {
        detection_source: source, use_staged: useStaged, include_untracked: !!includeUntracked,
        git_change_classification: buildGitChangeClassificationEvidence(gitChangeClassification),
        authorized_files: normalizedChanged,
        authorized_files_count: normalizedChanged.length,
        authorized_files_sha256: filesFingerprint,
        changed_files: normalizedChanged, changed_files_count: normalizedChanged.length,
        ignored_generated_runtime_files: [...new Set(ignoredGeneratedRuntimeFiles)].sort(),
        ignored_generated_runtime_files_count: new Set(ignoredGeneratedRuntimeFiles).size,
        additions_total: additionsTotal, deletions_total: deletionsTotal,
        changed_lines_total: changedLinesTotal,
        changed_file_stats: diffFileStats,
        changed_files_sha256: filesFingerprint,
        scope_content_sha256: contentFingerprint,
        scope_sha256: scopeFingerprint
    };
}

function countWorktreeFileLines(repoRoot: string, relativePath: string): number {
    const normalized = normalizePath(relativePath);
    if (!normalized || getSafeWorktreePathState(repoRoot, normalized).status !== 'file') {
        return 0;
    }
    return countFileLines(path.join(repoRoot, normalized));
}

function resolvePreflightContainingGitRoot(preflightPath: string): string {
    let candidate = path.dirname(path.resolve(preflightPath));
    while (true) {
        if (fs.existsSync(path.join(candidate, '.git'))) {
            return candidate;
        }
        const parent = path.dirname(candidate);
        if (parent === candidate) {
            throw new Error('Unable to resolve a git root containing preflight artifact ' + preflightPath + '.');
        }
        candidate = parent;
    }
}

/**
 * Get preflight context for scope validation.
 */
export function getPreflightContext(preflightPath: string, taskId: string) {
    if (!preflightPath || !fs.existsSync(preflightPath)) {
        throw new Error(`Preflight artifact not found: ${preflightPath}`);
    }
    let preflightObject;
    try {
        preflightObject = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    } catch {
        throw new Error(`Preflight artifact is not valid JSON: ${preflightPath}`);
    }

    const preflightTaskId = String(preflightObject.task_id || '').trim();
    if (preflightTaskId && preflightTaskId !== taskId) {
        throw new Error(`TaskId '${taskId}' does not match preflight.task_id '${preflightTaskId}'.`);
    }
    if (!('changed_files' in preflightObject)) throw new Error('Preflight field `changed_files` is required.');
    if (!preflightObject.metrics || typeof preflightObject.metrics !== 'object') {
        throw new Error('Preflight field `metrics` is required.');
    }
    const metrics = preflightObject.metrics as Record<string, unknown>;
    if (!preflightObject.required_reviews || typeof preflightObject.required_reviews !== 'object') {
        throw new Error('Preflight field `required_reviews` is required.');
    }

    const preflightChangedFiles = [...new Set(
        (preflightObject.changed_files || []).map((f: string) => normalizePath(String(f).replace(/\\/g, '/'))).filter(Boolean)
    )].sort();
    const preflightAuthorizedFiles: string[] = [...new Set<string>(
        (Array.isArray(preflightObject.authorized_files)
            ? preflightObject.authorized_files
            : preflightObject.changed_files || [])
            .map((f: string) => normalizePath(String(f).replace(/\\/g, '/')))
            .filter(Boolean)
    )].sort();

    const changedLinesTotal = metrics.changed_lines_total;
    if (typeof changedLinesTotal !== 'number' || changedLinesTotal < 0) {
        throw new Error('Preflight field `metrics.changed_lines_total` is required and must be non-negative.');
    }

    const detectionSource = String(preflightObject.detection_source || 'git_auto').trim() || 'git_auto';
    if (parseSplitCheckpointDetectionSource(detectionSource)) {
        resolveAuthenticatedSplitCheckpointPreflightScope(
            resolvePreflightContainingGitRoot(preflightPath),
            taskId,
            detectionSource,
            preflightChangedFiles
        );
    }
    const includeUntracked = parseSplitCheckpointDetectionSource(detectionSource)
        ? false
        : detectionSource.toLowerCase() !== 'git_staged_only';
    const scopeSha256 = typeof metrics.scope_sha256 === 'string'
        ? metrics.scope_sha256.trim().toLowerCase()
        : null;
    const scopeContentSha256 = typeof metrics.scope_content_sha256 === 'string'
        ? metrics.scope_content_sha256.trim().toLowerCase()
        : null;
    const actualChangedFilesSha256 = typeof metrics.actual_changed_files_sha256 === 'string'
        ? metrics.actual_changed_files_sha256.trim().toLowerCase()
        : null;

    return {
        preflight: preflightObject,
        task_id: taskId,
        detection_source: detectionSource,
        include_untracked: includeUntracked,
        authorized_files: preflightAuthorizedFiles,
        authorized_files_count: preflightAuthorizedFiles.length,
        changed_files: preflightChangedFiles,
        changed_files_count: preflightChangedFiles.length,
        changed_lines_total: changedLinesTotal,
        changed_files_sha256: actualChangedFilesSha256 || stringSha256(preflightChangedFiles.join('\n')),
        scope_sha256: scopeSha256 || null,
        scope_content_sha256: scopeContentSha256 || null,
        budget_forecast: preflightObject.budget_forecast ?? null
    };
}
