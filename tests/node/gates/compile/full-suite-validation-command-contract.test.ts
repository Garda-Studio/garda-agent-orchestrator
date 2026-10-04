import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    validateFullSuiteCommandContract
} from '../../../../src/cli/commands/gate-flows/full-suite/full-suite-command-contract';

describe('full-suite command contract', () => {
    it('rejects syntax that the shared executor cannot parse before execution', () => {
        assert.equal(validateFullSuiteCommandContract('MODE=build node build.js').supported, false);
        for (const command of ['MODE=build node build.js', 'node build.js "unterminated', 'node build.js \u0000']) {
            const result = validateFullSuiteCommandContract(command);
            assert.equal(result.supported, false, command);
            assert.equal(result.provenance.rejection_reason, 'INVALID_ARGUMENT_SYNTAX', command);
            assert.match(result.violation || '', /argument syntax.*wrapper/i, command);
        }
    });

    it('preserves unquoted literal punctuation in direct suite arguments', () => {
        const result = validateFullSuiteCommandContract('node build.js $NAME folder(name) `value` $(value)');
        assert.equal(result.supported, true);
        assert.equal(result.provenance.validation_status, 'PASSED');
        assert.equal(result.violation, null);
    });

    it('preserves quoted literal punctuation and empty arguments in direct suite commands', () => {
        for (const command of ['node build.js "$NAME"', 'node build.js "folder(name)"',
            'node build.js "`value`"', 'node build.js "a;b>c<d"', 'node build.js ""',
            'env MODE=build node build.js', 'node --test --test-name-pattern "(A|B)$" test.js']) {
            assert.equal(validateFullSuiteCommandContract(command).supported, true, command);
        }
        assert.equal(validateFullSuiteCommandContract('').supported, true);
    });

    it('rejects unquoted compound command syntax before execution', () => {
        const result = validateFullSuiteCommandContract('node first.js && node second.js');

        assert.equal(result.supported, false);
        assert.equal(result.provenance.validation_status, 'REJECTED');
        assert.equal(result.provenance.rejection_reason, 'SHELL_CONTROL_OPERATOR');
        assert.match(result.violation || '', /wrapper npm script/);
    });

    it('rejects other POSIX and Windows-style unquoted shell control operators', () => {
        for (const command of [
            'node first.js || node second.js',
            'node first.js | node second.js',
            'node first.js > output.log',
            'node first.js & node second.js'
        ]) {
            const result = validateFullSuiteCommandContract(command);
            assert.equal(result.supported, false, command);
            assert.equal(result.provenance.validation_status, 'REJECTED');
            assert.equal(result.provenance.rejection_reason, 'SHELL_CONTROL_OPERATOR');
            assert.match(result.violation || '', /wrapper npm script/);
        }
    });

    it('preserves shell-like text inside ordinary quoted arguments', () => {
        const result = validateFullSuiteCommandContract(
            'node -e "console.log(\'quoted && literal | text > value\')"'
        );
        const shellNamedArgumentResult = validateFullSuiteCommandContract(
            'node scripts/check-output.js sh'
        );
        const shellCommandDataArgumentResult = validateFullSuiteCommandContract(
            'node scripts/check-output.js sh -c'
        );
        const envOptionArgumentResult = validateFullSuiteCommandContract(
            'env -u sh NODE_ENV=test node scripts/check-output.js sh'
        );
        const envAttachedOptionArgumentResult = validateFullSuiteCommandContract(
            'env -uS node scripts/check-output.js sh'
        );
        const wslOrdinaryCommandResult = validateFullSuiteCommandContract(
            'wsl.exe --distribution Ubuntu --user root --exec node scripts/check-output.js sh'
        );

        assert.equal(result.supported, true);
        assert.equal(shellNamedArgumentResult.supported, true);
        assert.equal(shellCommandDataArgumentResult.supported, true);
        assert.equal(envOptionArgumentResult.supported, true);
        assert.equal(envAttachedOptionArgumentResult.supported, true);
        assert.equal(wslOrdinaryCommandResult.supported, true);
        assert.deepEqual(result.provenance, {
            schema_version: 1,
            source: 'workflow_config.full_suite_validation.command',
            execution_mode: 'DIRECT_ARGV',
            validation_status: 'PASSED',
            rejection_reason: null,
            detected_syntax: null
        });
    });

    it('accepts an npm wrapper script as one direct command', () => {
        const result = validateFullSuiteCommandContract('npm run test:full-suite');
        const extensionlessWrapperResult = validateFullSuiteCommandContract(
            './scripts/full-suite-wrapper --strict'
        );

        assert.equal(result.supported, true);
        assert.equal(result.violation, null);
        assert.equal(extensionlessWrapperResult.supported, true);
    });

    it('rejects shell interpreter escape hatches before execution', () => {
        const cmdResult = validateFullSuiteCommandContract(
            'cmd.exe /d /s /c "node first.js && node second.js"'
        );
        const shClusterResult = validateFullSuiteCommandContract(
            'sh -ec "node first.js && node second.js"'
        );
        const bashClusterResult = validateFullSuiteCommandContract(
            'bash -lc "node first.js && node second.js"'
        );
        const powershellAliasResult = validateFullSuiteCommandContract(
            'pwsh -enc ZQBjAGgAbwAgAHQAZQBzAHQA'
        );
        const powershellCommandWithArgsResult = validateFullSuiteCommandContract(
            'pwsh -CommandWithArgs "node first.js; node second.js"'
        );
        const wrappedShellResult = validateFullSuiteCommandContract(
            'env sh -c "node first.js && node second.js"'
        );
        const shellScriptResult = validateFullSuiteCommandContract('bash ./full-suite.sh');
        const powershellScriptResult = validateFullSuiteCommandContract('pwsh -File ./full-suite.ps1');
        const windowsBatchResult = validateFullSuiteCommandContract('./full-suite.cmd --strict');
        const directShellScriptResult = validateFullSuiteCommandContract('./full-suite.sh --strict');

        assert.equal(cmdResult.supported, false);
        assert.equal(shClusterResult.supported, false);
        assert.equal(bashClusterResult.supported, false);
        assert.equal(powershellAliasResult.supported, false);
        assert.equal(powershellCommandWithArgsResult.supported, false);
        assert.equal(wrappedShellResult.supported, false);
        assert.equal(shellScriptResult.supported, false);
        assert.equal(powershellScriptResult.supported, false);
        assert.equal(windowsBatchResult.supported, false);
        assert.equal(directShellScriptResult.supported, false);
        assert.equal(powershellAliasResult.provenance.rejection_reason, 'SHELL_INTERPRETER');
        assert.match(cmdResult.violation || '', /outside the direct argv execution contract/);
    });

    it('rejects other explicit shell interpreter escape hatches', () => {
        for (const command of [
            'sh -c "node first.js && node second.js"',
            '"sh " -c "node first.js && node second.js"',
            'bash.exe -c "node first.js && node second.js"',
            'fish -c "node first.js && node second.js"',
            'csh.exe -c "node first.js && node second.js"',
            '"cmd.exe " /c "node first.js && node second.js"',
            'pwsh -Command "node first.js; node second.js"',
            'env NODE_ENV=test sh -c "node first.js && node second.js"',
            'env -- NODE_ENV=test sh -c "node first.js && node second.js"',
            'env -S "sh -c node-first-and-second"',
            'env -iS "sh -c node-first-and-second"',
            'env --argv0 harmless sh -c "node first.js"',
            'env --argv0=harmless sh -c "node first.js"',
            'env -a harmless sh -c "node first.js"',
            'env -aharmless sh -c "node first.js"',
            'env -iC . sh -c "node first.js"',
            'env -iu SHELL sh -c "node first.js"',
            'busybox sh -c "node first.js"',
            'busybox.exe ash -c "node first.js"',
            'toybox sh -c "node first.js"',
            'env busybox sh -c "node first.js"',
            'busybox env sh -c "node first.js"',
            './full-suite.fish --strict',
            './full-suite.command --strict'
        ]) {
            const result = validateFullSuiteCommandContract(command);
            assert.equal(result.supported, false, command);
            assert.equal(result.provenance.rejection_reason, 'SHELL_INTERPRETER');
        }
    });

    it('rejects nested shell command signatures behind arbitrary process wrappers', () => {
        for (const command of [
            'nice sh -c "node first.js && node second.js"',
            'nice -n 5 sh -c "node first.js && node second.js"',
            'nice sh -x -c "node first.js && node second.js"',
            'nice bash -lc "node first.js && node second.js"',
            'nice bash -x -lc "node first.js && node second.js"',
            'nice cmd.exe /d /c "node first.js && node second.js"',
            'nice pwsh -Command "node first.js; node second.js"'
        ]) {
            const result = validateFullSuiteCommandContract(command);
            assert.equal(result.supported, false, command);
            assert.equal(result.provenance.rejection_reason, 'SHELL_INTERPRETER');
        }
    });

    it('allows nice to delegate to an ordinary direct-argv command', () => {
        const result = validateFullSuiteCommandContract(
            'nice -n 5 node scripts/check-output.js sh'
        );

        assert.equal(result.supported, true);
        assert.equal(result.violation, null);
        assert.equal(result.provenance.validation_status, 'PASSED');
    });

    it('rejects WSL-delegated shell interpreter escape hatches', () => {
        const directResult = validateFullSuiteCommandContract('wsl.exe sh -c "node first.js"');
        const execResult = validateFullSuiteCommandContract('wsl --exec bash -lc "node first.js"');
        const equalsExecResult = validateFullSuiteCommandContract('wsl --exec=sh -c "node first.js"');
        const optionResult = validateFullSuiteCommandContract(
            'wsl -d Ubuntu -u root --shell-type login sh -c "node first.js"'
        );
        const quotedCompoundResult = validateFullSuiteCommandContract(
            'wsl.exe --distribution Ubuntu "node first.js && node second.js"'
        );
        const standardShellTypeResult = validateFullSuiteCommandContract(
            'wsl --shell-type standard node scripts/check-output.js'
        );
        const loginShellTypeResult = validateFullSuiteCommandContract(
            'wsl --shell-type=login node scripts/check-output.js'
        );
        const envResult = validateFullSuiteCommandContract(
            'env wsl.exe --distribution=Ubuntu pwsh -Command "node first.js"'
        );
        const nestedResult = validateFullSuiteCommandContract(
            'wsl.exe busybox ash -c "node first.js"'
        );
        const defaultShellResult = validateFullSuiteCommandContract('wsl.exe');
        const optionOnlyDefaultShellResult = validateFullSuiteCommandContract(
            'wsl --distribution Ubuntu --user root'
        );
        const homeDefaultShellResult = validateFullSuiteCommandContract('wsl ~');
        const optionHomeDefaultShellResult = validateFullSuiteCommandContract(
            'wsl --distribution Ubuntu ~'
        );
        const debugShellResult = validateFullSuiteCommandContract('wsl --debug-shell');
        const emptyBoundaryResult = validateFullSuiteCommandContract('wsl --');
        const emptyExecResult = validateFullSuiteCommandContract('wsl --exec=');

        assert.equal(directResult.supported, false);
        assert.equal(execResult.supported, false);
        assert.equal(equalsExecResult.supported, false);
        assert.equal(optionResult.supported, false);
        assert.equal(quotedCompoundResult.supported, false);
        assert.equal(standardShellTypeResult.supported, false);
        assert.equal(loginShellTypeResult.supported, false);
        assert.equal(envResult.supported, false);
        assert.equal(nestedResult.supported, false);
        assert.equal(defaultShellResult.supported, false);
        assert.equal(optionOnlyDefaultShellResult.supported, false);
        assert.equal(homeDefaultShellResult.supported, false);
        assert.equal(optionHomeDefaultShellResult.supported, false);
        assert.equal(debugShellResult.supported, false);
        assert.equal(emptyBoundaryResult.supported, false);
        assert.equal(emptyExecResult.supported, false);
        assert.equal(directResult.provenance.rejection_reason, 'SHELL_INTERPRETER');
    });

    it('handles long multiplexer chains without recursive tail copies', () => {
        const wrappers = Array.from({ length: 10_000 }, () => 'busybox').join(' ');
        const result = validateFullSuiteCommandContract(`${wrappers} sh -c "node first.js"`);

        assert.equal(result.supported, false);
        assert.equal(result.provenance.rejection_reason, 'SHELL_INTERPRETER');
        assert.equal(result.provenance.detected_syntax, 'sh');
    });

    it('rejects invalid quoting before subprocess launch', () => {
        const result = validateFullSuiteCommandContract('node -e "unterminated');

        assert.equal(result.supported, false);
        assert.equal(result.provenance.rejection_reason, 'INVALID_ARGUMENT_SYNTAX');
        assert.match(result.violation || '', /unterminated quoting or escaping/);
    });
});
