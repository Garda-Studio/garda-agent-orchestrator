import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildScopeContentFingerprint,
    getCompileCommandProfile,
    getCompileCommands,
    getCompileCommandContractViolations,
    validateCompileGateCommand,
    getOutputStats,
    getWorkspaceSnapshot,
    extractNewPathFromNumstat
} from '../../../../src/gates/compile/compile-gate';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../../src/core/constants';
import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';

describe('gates/compile-gate', () => {
    describe('command chain contract', () => {
        it('accepts quoted paths, literal conjunctions and supported build chains', () => {
            assert.doesNotThrow(() => validateCompileGateCommand(
                'npm --prefix "store frontend" run build && mvn -f "service backend/pom.xml" -DskipTests compile', 'test'
            ));
            assert.doesNotThrow(() => validateCompileGateCommand('node -e "console.log(\'&&\')" && npm run typecheck', 'test'));
        });

        it('accepts build chains from different toolchains and arbitrary executables', () => {
            assert.doesNotThrow(() => validateCompileGateCommand(
                'make all && python build.py && dotnet build && go build ./... && cargo build && '
                    + './gradlew assemble && custom-builder --destination "output folder"', 'test'
            ));
        });

        it('does not share Maven skip-test flags between commands', () => {
            assert.ok(getCompileCommandContractViolations('mvn -DskipTests package && mvn package')
                .some((violation) => violation.includes("Maven phase 'package'")));
        });

        it('checks every Maven phase and only effective skip properties from option operands', () => {
            for (const command of ['mvn -DskipTests package test', 'mvn -Dmaven.test.skip=true install test',
                'npm exec -- mvn -DskipTests package test', 'mvn -f "-DskipTests" verify',
                'mvn -DskipTests -DskipTests=false package', 'mvn -Dmaven.test.skip=true -Dmaven.test.skip=false verify',
                'npm exec --package "-DskipTests" -- mvn verify', 'mvn -Dskiptests=true package', 'mvn -dskipTests=true package']) {
                assert.ok(getCompileCommandContractViolations(command).some((violation) => violation.includes('Maven phase')), command);
                assert.throws(() => validateCompileGateCommand(command, 'test'), /Maven phase/i);
            }
            for (const command of ['mvn -DskipTests=false -DskipTests package verify', 'mvn -D skipTests=true package',
                'mvn --define skipTests=true package', 'mvn --define=maven.test.skip=true verify']) {
                assert.deepEqual(getCompileCommandContractViolations(command), [], command);
            }
        });

        it('rejects assignments with quoted values while retaining quoted literal executable names', () => {
            for (const assignment of ['FOO="bar"', "FOO='bar'", 'FOO=pre" spaced "post', 'FOO=""']) {
                assert.throws(() => validateCompileGateCommand('npm run build && ' + assignment + ' npm run build', 'test'),
                    /environment assignment/i);
            }
            assert.doesNotThrow(() => validateCompileGateCommand('"FOO=bar" build && custom-builder --setting FOO="bar"', 'test'));
        });

        it('does not let Maven-looking arguments suppress another executable test restriction', () => {
            for (const command of ['npm run test -- mvn', 'npm run build && npm run test -- mvn',
                'npm --prefix "store frontend" run test -- "/opt/maven tools/mvn"']) {
                assert.ok(getCompileCommandContractViolations(command)
                    .some((violation) => violation.includes('test command')));
                assert.throws(() => validateCompileGateCommand(command, 'test'), /test command/i);
            }
        });

        it('does not reinterpret multiword literal arguments as test commands', () => {
            for (const command of ['node build.js "npm test"', 'node build.js "prefix npm test suffix"',
                'npm run build -- "cargo test"', 'node build.js "pytest target" && npm run typecheck']) {
                assert.deepEqual(getCompileCommandContractViolations(command), []);
                assert.doesNotThrow(() => validateCompileGateCommand(command, 'test'));
            }
        });

        it('keeps tool and test names in ordinary program arguments as data', () => {
            for (const command of ['node build.js "pytest"', 'custom-builder --tool mvn verify',
                'custom-builder --tool gradle build', 'npm run build -- pytest', 'go build --label "npm test"',
                'python build.py --tool pytest']) {
                assert.deepEqual(getCompileCommandContractViolations(command), []);
                assert.doesNotThrow(() => validateCompileGateCommand(command, 'test'));
            }
        });

        it('retains direct and delegated real test command restrictions', () => {
            for (const command of ['"/opt/test tools/pytest" target', 'npm run "test"', 'npx --yes jest',
                'corepack pnpm test', 'nice mvn verify', 'npm exec -- mvn verify', 'python -m pytest target']) {
                assert.ok(getCompileCommandContractViolations(command).length > 0, command);
            }
        });

        it('keeps executable whitespace literal rather than normalizing it into a known test tool', () => {
            for (const command of ['"npm " test', '" pytest" target', '"mvn " verify', '"gradle " build']) {
                assert.deepEqual(getCompileCommandContractViolations(command), [], command);
            }
            assert.ok(getCompileCommandContractViolations('"npm" test').length > 0);
            assert.ok(getCompileCommandContractViolations('"pytest" target').length > 0);
            assert.ok(getCompileCommandContractViolations('"mvn" verify').length > 0);
            assert.ok(getCompileCommandContractViolations('"gradle" build').length > 0);
        });

        it('checks Python modules after interpreter and launcher options', () => {
            for (const command of ['python -O -m pytest', 'py -3 -m pytest', 'python3.12 -I -u -m pytest',
                'python -W ignore -X dev -m pytest', 'python -Wdefault -Xdev -mpytest', 'python -Om pytest',
                'npm run build && python -O -m pytest', '"C:/Python Tools/python.exe" -O -m pytest']) {
                assert.ok(getCompileCommandContractViolations(command)
                    .some((violation) => violation.includes('test command')), command);
                assert.throws(() => validateCompileGateCommand(command, 'test'), /test command/i);
            }
            for (const command of ['python build.py -m pytest', 'python -c "print(1)" -m pytest',
                'python -- build.py -m pytest', 'python -W pytest build.py', 'python -X pytest build.py']) {
                assert.deepEqual(getCompileCommandContractViolations(command), [], command);
            }
        });

        it('rejects Python test modules hidden by option case or clustered flags', () => {
            assert.ok(getCompileCommandContractViolations('python -x -m pytest').length > 0);
            for (const command of ['python -xm pytest', 'python -Bx -m pytest', 'python -Bxmpytest',
                'python -x -W ignore -X dev -m pytest', 'python -BX dev -m pytest', 'python -BW ignore -m pytest',
                'python -BWdefault -Xdev -xm pytest', 'py -3 -x -m pytest',
                'corepack npm x -- python -x -m pytest', 'npm run build && python -x -m pytest',
                'python --check-hash-based-pycs always -x -m pytest', '"C:/Python Tools/python.exe" -x -m pytest']) {
                assert.ok(getCompileCommandContractViolations(command)
                    .some((violation) => violation.includes('test command')), command);
                assert.throws(() => validateCompileGateCommand(command, 'test'), /test command/i);
            }
            for (const command of ['python -x build.py -m pytest', 'python -X "-m" pytest',
                'python -W "-m" pytest', 'python -BX pytest build.py', 'python -BW pytest build.py',
                'python -Xpytest -Wignore build.py', 'python -Bc "print(1)" -m pytest',
                'python --check-hash-based-pycs "-m" pytest', 'python -x -- build.py -m pytest',
                'python - -m pytest', 'python -x - -m pytest']) {
                assert.deepEqual(getCompileCommandContractViolations(command), [], command);
                assert.doesNotThrow(() => validateCompileGateCommand(command, 'test'));
            }
        });

        it('resolves delegated executable boundaries without interpreting later data', () => {
            for (const command of ['corepack npm test -- gradle -x test', 'corepack npm run test -- mvn compile',
                'npx --package tool-set jest', 'npm exec --package tool-set -- pytest',
                'env --unset VARIABLE MODE=build nice -n 5 mvn verify', 'corepack pnpm -C "test" run --silent test']) {
                assert.ok(getCompileCommandContractViolations(command).length > 0, command);
                assert.throws(() => validateCompileGateCommand(command, 'test'), /must not run the full test suite/i);
            }
            for (const command of ['npx custom-builder --label "pytest"', 'npm exec -- custom-builder --label "pytest"',
                'corepack npm run build -- gradle build', 'corepack pnpm -C "test" run build',
                'env MODE=build nice -n 5 mvn -DskipTests package', 'npx --yes gradle build -x test',
                'npm exec --package "pytest" -- custom-builder', 'nice -n 5 custom-builder --tool mvn verify',
                'busybox echo pytest', 'time -o "pytest" custom-builder --label pytest']) {
                assert.deepEqual(getCompileCommandContractViolations(command), [], command);
                assert.doesNotThrow(() => validateCompileGateCommand(command, 'test'));
            }
        });

        it('keeps Maven file options and npm prefix paths distinct from lifecycle goals', () => {
            assert.deepEqual(getCompileCommandContractViolations('mvn -f "test" compile'), []);
            assert.deepEqual(getCompileCommandContractViolations('npm --prefix "test" run build'), []);
            assert.ok(getCompileCommandContractViolations('npm --prefix="first path" --prefix "second path" run test')
                .some((violation) => violation.includes('test command')));
        });

        it('rejects delegated test runners invoked through package-runner aliases', () => {
            assert.ok(getCompileCommandContractViolations('npm x jest').length > 0);
            for (const command of ['npm --prefix "store frontend" x -- jest',
                'npm x --package tools -- jest', 'npm x -p jest', 'npm exec -p jest', 'corepack npm x jest',
                'npm run -p test', 'pnpm dlx -C "store frontend" jest', 'pnpm -F "store frontend" test',
                'bun x jest', 'bun x --bun jest', 'bunx jest', 'bunx --bun jest', 'bunx -p tools jest',
                'pnpx jest', 'pnx jest', 'pnpx -c jest', 'pnx --shell-mode jest', 'pnpm dlx -c jest',
                'pnpx --allow-build tool-set jest', 'pnx --allow-build tool-set jest',
                'yarnpkg jest', 'yarnpkg --cwd "store frontend" run test', 'yarnpkg exec jest',
                'npm x -- mvn verify', 'bunx gradle build']) {
                assert.ok(getCompileCommandContractViolations(command).length > 0, command);
                assert.ok(getCompileCommandContractViolations('npm run build && ' + command).length > 0, command);
                assert.throws(() => validateCompileGateCommand(command, 'test'), /must not run the full test suite/i);
            }
        });

        it('rejects test commands carried by npm call options and pnpm shell mode', () => {
            assert.ok(getCompileCommandContractViolations('npm exec --call jest').length > 0);
            for (const command of ['npm exec -c jest', 'npm x --call="jest --runInBand"',
                'npm exec -c="pytest target"', 'npm --call jest exec', 'npm -yc jest exec', 'corepack npm x -yc jest',
                'npx --call jest', 'npx -p tools -c "jest --runInBand"', 'npx --call="cargo test"',
                'npm exec --package tools --call "mvn verify"', 'npm x -c "gradle build"',
                'npm exec --call "npm run build && pytest target"',
                'npm x -c "npx --call=jest"', 'npm exec --call builder --call jest',
                'pnpm -c exec "jest --runInBand"', 'pnpm --shell-mode exec "cargo test"',
                'pnpm -rc exec "pytest target"', 'pnpm dlx -c "jest --runInBand"',
                'pnpx --package tools -c "npm run build && pytest target"', 'pnx -c "mvn verify"']) {
                assert.ok(getCompileCommandContractViolations(command).length > 0, command);
                assert.ok(getCompileCommandContractViolations('npm run build && ' + command).length > 0, command);
                assert.throws(() => validateCompileGateCommand(command, 'test'), /must not run the full test suite/i);
            }
            assert.ok(getCompileCommandContractViolations('npm exec --call custom-builder',
                { fullSuiteCommand: 'custom-builder' }).length > 0);
            assert.doesNotThrow(() => validateCompileGateCommand('npm exec --call jest', 'test',
                { allowFullTestCompileCommand: true, allowFullTestCompileCommandReason: 'explicit approved override' }));
        });

        it('preserves compile calls and option data at package-runner argument boundaries', () => {
            for (const command of ['npm exec --call "npm run build"', 'npx -c ' + JSON.stringify('mvn -f "test" compile'),
                'corepack npm x --call="gradle build -x test"', 'npm exec --call "custom-builder --label jest"',
                'npm exec --call ' + JSON.stringify('node build.js "cargo test"'), 'npm exec --call jest --call custom-builder',
                'npm exec --package "--call=jest" -- custom-builder',
                'npm --prefix "--call=jest" exec -- custom-builder',
                'npm exec --loglevel "--call=jest" -- custom-builder',
                'npx custom-builder --call jest', 'npx --package "--call=jest" custom-builder',
                'npm exec -- custom-builder --call jest', 'npm run build --call jest',
                'pnpm -c exec "custom-builder --label jest"', 'pnpx -c "gradle build -x test"',
                'pnpm --shell-mode=false exec "jest --runInBand"',
                'pnpx --package "--shell-mode" custom-builder --label jest']) {
                assert.deepEqual(getCompileCommandContractViolations(command), [], command);
                assert.doesNotThrow(() => validateCompileGateCommand(command, 'test'));
            }
        });

        it('rejects unsupported syntax inside executable package-runner command strings', () => {
            assert.throws(() => validateCompileGateCommand('npm exec --call "builder | jest"', 'test'),
                /Unsupported command syntax/i);
            assert.throws(() => validateCompileGateCommand('pnpx -c "builder; jest"', 'test'),
                /Unsupported command syntax/i);
            assert.throws(() => validateCompileGateCommand('npm exec --call "builder | jest"', 'test',
                { allowFullTestCompileCommand: true, allowFullTestCompileCommandReason: 'approved tests' }),
                /Unsupported command syntax/i);
        });

        it('rejects shell expansion and escaping in executable package-runner strings', () => {
            assert.throws(() => validateCompileGateCommand('npm exec --call ' + JSON.stringify('echo "$(pytest)"'), 'test'),
                /Unsupported executable command-string syntax/i);
            for (const text of ['echo "$(pytest)"', 'echo "`pytest`"', 'echo "$RUNNER"',
                'echo "%RUNNER%"', 'echo "!RUNNER!"', 'j^e^s^t', 'j\\est', 'j*st', 'je?t',
                'echo "line\n&& jest"', "echo 'build && jest'", 'echo ~', 'echo {build,test}', 'echo [a-z]']) {
                for (const runner of ['npm exec --call', 'npx -c', 'pnpm -c exec', 'pnpx -c']) {
                    const command = runner + ' ' + JSON.stringify(text);
                    assert.throws(() => validateCompileGateCommand(command, 'test'),
                        /Unsupported executable command-string syntax/i, command);
                    assert.throws(() => validateCompileGateCommand(command, 'test',
                        { allowFullTestCompileCommand: true, allowFullTestCompileCommandReason: 'approved tests' }),
                        /Unsupported executable command-string syntax/i, command);
                }
            }
            for (const command of ['node build.js "$(pytest)"', 'npm run build -- "--call=$(pytest)"',
                'npm exec -- custom-builder --call "$(pytest)"', 'npx custom-builder --call "$(pytest)"']) {
                assert.deepEqual(getCompileCommandContractViolations(command), [], command);
            }
        });

        it('rejects unquoted native package-runner parentheses', () => {
            assert.throws(() => validateCompileGateCommand('npm exec --call "(npm test)"', 'test'),
                /Unsupported executable command-string syntax/i);
            for (const text of ['(npm test)', '(custom-suite)', '(sh -c pytest)',
                'builder && (npm test)', '((npm test))', '( npm test )', 'builder folder(name)']) {
                for (const runner of ['npm exec --call', 'npx -c', 'pnpm -c exec', 'pnpx -c']) {
                    const command = runner + ' ' + JSON.stringify(text);
                    assert.throws(() => validateCompileGateCommand(command, 'test',
                        { fullSuiteCommand: 'custom-suite' }), /Unsupported executable command-string syntax/i, command);
                    assert.throws(() => validateCompileGateCommand(command, 'test',
                        { allowFullTestCompileCommand: true, allowFullTestCompileCommandReason: 'approved tests' }),
                        /Unsupported executable command-string syntax/i, command);
                }
            }
        });

        it('preserves quoted native package-runner parentheses and direct argv', () => {
            assert.deepEqual(getCompileCommandContractViolations('node build.js folder(name)'), []);
            for (const runner of ['npm exec --call', 'npx -c', 'pnpm -c exec', 'pnpx -c']) {
                for (const text of ['custom-builder "folder(name)"', 'custom-builder "(npm test)"',
                    'custom-builder "folder(name)" && npm run build']) {
                    assert.deepEqual(getCompileCommandContractViolations(runner + ' ' + JSON.stringify(text)), []);
                }
            }
        });

        it('rejects native package-runner comments before suite identity checks', () => {
            assert.throws(() => validateCompileGateCommand('npm exec --call "npm run verify # ignored"', 'test',
                { fullSuiteCommand: 'npm run verify' }), /Unsupported executable command-string syntax/i);
            for (const text of ['npm run verify # ignored', 'custom-suite # ignored',
                'custom-builder &&# ignored', '# ignored', 'custom-builder\t# ignored', 'custom-builder #ignored']) {
                for (const runner of ['npm exec --call', 'npx -c', 'pnpm -c exec', 'pnpx -c']) {
                    const command = runner + ' ' + JSON.stringify(text);
                    assert.throws(() => validateCompileGateCommand(command, 'test',
                        { fullSuiteCommand: 'npm run verify' }), /Unsupported executable command-string syntax/i, command);
                    assert.throws(() => validateCompileGateCommand(command, 'test',
                        { allowFullTestCompileCommand: true, allowFullTestCompileCommandReason: 'approved tests' }),
                        /Unsupported executable command-string syntax/i, command);
                }
            }
        });

        it('preserves native package-runner literal hashes and direct argv', () => {
            assert.deepEqual(getCompileCommandContractViolations('node build.js #tag'), []);
            for (const runner of ['npm exec --call', 'npx -c', 'pnpm -c exec', 'pnpx -c']) {
                for (const text of ['custom-builder "folder#name"', 'custom-builder "# npm run verify"',
                    'custom-builder folder#name', 'custom-builder ""#tag', 'custom-builder "prefix"#tag',
                    'custom-builder "folder#name" && npm run build']) {
                    assert.deepEqual(getCompileCommandContractViolations(runner + ' ' + JSON.stringify(text)), []);
                }
            }
        });

        it('rejects native shell dispatch in compile configuration', () => {
            assert.throws(() => validateCompileGateCommand('sh -c pytest', 'test'),
                /Unsupported executable command dispatch/i);
            const dispatched = ['exec pytest target', 'command pytest target', 'eval pytest target',
                'source suite.sh', '. suite.sh', 'sh -c pytest', 'bash -lc "pytest target"',
                'bash -eo pipefail -c pytest', 'fish --init-command pytest',
                'cmd /c jest --runInBand', 'cmd /k jest', 'pwsh -Command pytest',
                'powershell -NoProfile -EncodedCommand cHl0ZXN0', 'pwsh -cwa pytest',
                'pwsh -exec Bypass -commandwitharg pytest'];
            for (const text of dispatched) {
                for (const command of [text, ...['npm exec --call', 'npx -c', 'pnpm -c exec', 'pnpx -c']
                    .map((runner) => runner + ' ' + JSON.stringify(text))]) {
                    assert.throws(() => validateCompileGateCommand(command, 'test'),
                        /Unsupported executable command dispatch/i, command);
                    assert.throws(() => validateCompileGateCommand(command, 'test',
                        { allowFullTestCompileCommand: true, allowFullTestCompileCommandReason: 'approved tests' }),
                        /Unsupported executable command dispatch/i, command);
                }
            }
            for (const command of ['sh scripts/build.sh -c pytest', 'bash -- scripts/build.sh -c pytest',
                'pwsh -NoProfile -ExecutionPolicy Bypass -File "build scripts/build.ps1" -Command pytest',
                'node build.js "sh -c pytest"', 'npm exec --call "node build.js exec pytest"']) {
                assert.deepEqual(getCompileCommandContractViolations(command), [], command);
            }
        });

        it('rejects env split-string execution without reinterpreting option data', () => {
            assert.throws(() => validateCompileGateCommand('env -S "pytest target"', 'test'),
                /Unsupported executable command dispatch/i);
            for (const text of ['env -S "pytest target"', 'env -iS "pytest target"',
                'env -Spytest', 'env --split-string "pytest target"', 'env --split-string=pytest',
                'env --split-str "pytest target"',
                'env -u NAME -S "custom-suite"']) {
                for (const command of [text, 'npm exec --call ' + JSON.stringify(text)]) {
                    assert.throws(() => validateCompileGateCommand(command, 'test', { fullSuiteCommand: 'custom-suite' }),
                        /Unsupported executable command dispatch/i, command);
                    assert.throws(() => validateCompileGateCommand(command, 'test',
                        { allowFullTestCompileCommand: true, allowFullTestCompileCommandReason: 'approved tests' }),
                        /Unsupported executable command dispatch/i, command);
                }
            }
            for (const command of ['env -u "-S" custom-builder', 'env -a "--split-string" custom-builder',
                'node build.js "env -S pytest"', 'env MODE=build custom-builder --label "-S"']) {
                assert.deepEqual(getCompileCommandContractViolations(command), [], command);
            }
        });

        it('preserves attached and clustered env option operands as literal data', () => {
            assert.doesNotThrow(() => validateCompileGateCommand('env -uNODE_OPTIONS npm run build', 'test'));
            for (const options of ['-uNODE_OPTIONS', '-uS', '-iuNODE_OPTIONS', '-iu "pytest"',
                '-C"build Sources"', '-iC "build Sources"', '--unset=NODE_OPTIONS', '-a"custom S"']) {
                for (const prefix of ['env', 'wsl --exec env', 'npm exec -- env']) {
                    assert.doesNotThrow(() => validateCompileGateCommand(prefix + ' ' + options + ' npm run build',
                        'test'), prefix + ' ' + options);
                }
            }
        });

        it('rejects test-bound dispatch after clustered env value options', () => {
            assert.ok(getCompileCommandContractViolations('env -iu NAME npm test').length > 0);
            for (const command of ['env -iu NAME npm test', 'env -iC "source folder" pytest target',
                'wsl --exec env -iu NAME npm test', 'npm exec -- env -iu NAME npm test']) {
                assert.throws(() => validateCompileGateCommand(command, 'test'), /must not run the full test suite/i, command);
            }
            for (const options of ['-iS "custom-suite"', '-viS "custom-suite"',
                '-uNODE_OPTIONS -S "custom-suite"', '-iu NAME -S "custom-suite"']) {
                assert.throws(() => validateCompileGateCommand('env ' + options, 'test'),
                    /Unsupported executable command dispatch/i, options);
            }
            assert.ok(getCompileCommandContractViolations('env -iu NAME custom-suite --mode verify',
                { fullSuiteCommand: 'custom-suite --mode verify' }).length > 0);
        });

        it('preserves process-wrapper abbreviated and clustered value operands', () => {
            assert.doesNotThrow(() => validateCompileGateCommand('env --un pytest npm run build', 'test'));
            for (const command of ['env --un pytest npm run build', 'env --u=NODE_OPTIONS npm run build',
                'env --ch "test" npm run build', 'time -vo pytest npm run build',
                'time -vf "sh -c pytest" npm run build', 'time --o "test" npm run build',
                'time --f "pytest" npm run build', 'nice --ad -5 npm run build']) {
                assert.doesNotThrow(() => validateCompileGateCommand(command, 'test'), command);
            }
        });

        it('rejects test-bound dispatch after process-wrapper abbreviated and clustered options', () => {
            assert.ok(getCompileCommandContractViolations('time -vo out.log npm test').length > 0);
            for (const command of ['time -vo out.log npm test', 'time -vf "%E" pytest target',
                'time --o log.txt npm test', 'env --un NAME npm test', 'env --ch "source folder" pytest target',
                'wsl --exec time -vo out.log npm test', 'npm exec -- env --un NAME npm test']) {
                assert.throws(() => validateCompileGateCommand(command, 'test'), /must not run the full test suite/i, command);
            }
            assert.throws(() => validateCompileGateCommand('time -vo out.log sh -c "custom-builder"', 'test'),
                /Unsupported executable command dispatch/i);
            assert.ok(getCompileCommandContractViolations('time -vo out.log custom-suite --mode verify',
                { fullSuiteCommand: 'custom-suite --mode verify' }).length > 0);
        });

        it('rejects test commands hidden by PNPM workspace-root option arity', () => {
            assert.ok(getCompileCommandContractViolations('pnpm -w test').length > 0);
            for (const command of ['pnpm -w run test', 'pnpm --workspace-root test', 'corepack pnpm -w test',
                'pnpm -w exec jest', 'pnpm -w -c exec "pytest target"', 'pnpm run -w test',
                'pn -w test', 'corepack pn run test', 'pn -w exec jest']) {
                assert.ok(getCompileCommandContractViolations(command).length > 0, command);
                assert.throws(() => validateCompileGateCommand(command, 'test'), /must not run the full test suite/i);
            }
            for (const command of ['pnpm -w build', 'pnpm -w run build', 'pn -w build',
                'pnpm -F "test" run build', 'pnpm -C "test" run build',
                'npm -w "test" run build', 'npm run -w "test" build']) {
                assert.deepEqual(getCompileCommandContractViolations(command), [], command);
            }
        });

        it('rejects configured full-suite shell-call segments before expanding their commands', () => {
            assert.ok(getCompileCommandContractViolations('npm run build && npm exec --call custom-suite',
                { fullSuiteCommand: 'npm exec --call custom-suite' })
                .includes('matches the configured full-suite validation command'));
            for (const suite of ['npm exec --call custom-suite', 'npm x -c custom-suite', 'npx -c custom-suite',
                'corepack npm exec --call custom-suite', 'pnpm -c exec custom-suite', 'pnpx -c custom-suite']) {
                for (const command of [suite + ' && custom-builder', 'custom-builder && ' + suite]) {
                    assert.ok(getCompileCommandContractViolations(command, { fullSuiteCommand: suite })
                        .includes('matches the configured full-suite validation command'), command);
                    assert.throws(() => validateCompileGateCommand(command, 'test', { fullSuiteCommand: suite }),
                        /configured full-suite validation command/i);
                    assert.doesNotThrow(() => validateCompileGateCommand(command, 'test',
                        { fullSuiteCommand: suite, allowFullTestCompileCommand: true,
                            allowFullTestCompileCommandReason: 'explicit approved override' }));
                }
            }
            assert.deepEqual(getCompileCommandContractViolations('node build.js "npm exec --call custom-suite"',
                { fullSuiteCommand: 'npm exec --call custom-suite' }), []);
        });

        it('preserves literal data and compile goals after package-runner aliases', () => {
            for (const command of ['npm x -- custom-builder --label jest', 'bun x custom-builder --tool pytest',
                'bunx --package jest custom-builder --label pytest', 'pnpx --package jest custom-builder --tool mvn verify',
                'pnx --package pytest custom-builder --tool gradle build', 'npm x -- mvn -f "test" compile',
                'bunx gradle --project-dir "test" assemble', 'bunx gradle build -x test',
                'pnpm x jest', 'yarn x jest', 'yarnpkg run build -- jest',
                'pnx --package jest --allow-build tool-set custom-builder --label pytest']) {
                assert.deepEqual(getCompileCommandContractViolations(command), [], command);
            }
        });

        it('keeps Maven tool option operands separate from lifecycle goals and skip properties', () => {
            for (const option of ['-l', '--log-file', '-t', '--toolchains', '-gt', '--global-toolchains', '-rf', '--resume-from',
                '-P', '--activate-profiles', '-pl', '--projects', '-b', '--builder', '-T', '--threads',
                '--color', '--metadata-update-policy']) {
                for (const value of ['test', '-DskipTests']) {
                    const prefix = 'mvn ' + option + ' "' + value + '" ';
                    assert.deepEqual(getCompileCommandContractViolations(prefix + 'compile'), [], prefix);
                    assert.ok(getCompileCommandContractViolations(prefix + 'verify').length > 0, prefix);
                    assert.ok(getCompileCommandContractViolations(prefix + '-DskipTests package test').length > 0, prefix);
                }
            }
            assert.deepEqual(getCompileCommandContractViolations('mvn --log-file=test compile'), []);
        });

        it('keeps Gradle tool option operands separate from task names', () => {
            for (const option of ['-p', '--project-dir', '-g', '--gradle-user-home', '-I', '--init-script',
                '--project-cache-dir', '--include-build', '-b', '--build-file', '-c', '--settings-file',
                '-D', '--system-prop', '-P', '--project-prop', '--console', '--warning-mode', '--max-workers', '--priority',
                '--update-locks', '--configuration-cache-problems', '--configuration-cache-max-problems',
                '-F', '--dependency-verification', '-M', '--write-verification-metadata']) {
                assert.deepEqual(getCompileCommandContractViolations('./gradlew ' + option + ' "test" assemble'), [], option);
                assert.deepEqual(getCompileCommandContractViolations('./gradlew assemble ' + option + ' "check"'), [], option);
                assert.ok(getCompileCommandContractViolations('./gradlew ' + option + ' "test" test').length > 0, option);
            }
            assert.deepEqual(getCompileCommandContractViolations('./gradlew --project-dir=test assemble'), []);
        });

        it('rejects test-bound Gradle commands that use option operands as false exclusions', () => {
            for (const option of ['--project-dir', '--init-script', '--project-cache-dir', '--include-build']) {
                assert.ok(getCompileCommandContractViolations('./gradlew ' + option + ' "--exclude-task=test" build')
                    .some((violation) => violation.includes("Gradle task 'build'")), option);
            }
            for (const option of ['-d', '-i', '-m']) {
                assert.ok(getCompileCommandContractViolations('./gradlew ' + option + ' test').length > 0, option);
            }
            assert.ok(getCompileCommandContractViolations('./gradlew -x "--exclude-task=test" build')
                .some((violation) => violation.includes("Gradle task 'build'")));
            assert.ok(getCompileCommandContractViolations('./gradlew --project-dir "test" assemble && ./gradlew test')
                .some((violation) => violation.includes("Gradle task 'test'")));
        });

        it('does not share Gradle test exclusions between commands', () => {
            assert.ok(getCompileCommandContractViolations('./gradlew build -x test && ./gradlew build')
                .some((violation) => violation.includes("Gradle task 'build'")));
        });

        it('recognizes test-bound Maven phases with a quoted executable path', () => {
            assert.ok(getCompileCommandContractViolations('"/opt/maven tools/mvn" -f "service backend/pom.xml" verify')
                .some((violation) => violation.includes("Maven phase 'verify'")));
        });

        it('rejects unsupported syntax even when the test-command override is approved', () => {
            assert.throws(() => validateCompileGateCommand('npm run build || npm run typecheck', 'test', {
                allowFullTestCompileCommand: true, allowFullTestCompileCommandReason: 'existing override'
            }), /Unsupported command syntax/i);
        });

        it('rejects test-bound commands after explicit WSL executable delegation', () => {
            for (const flag of ['--exec', '-e']) {
                for (const child of ['go test ./...', 'pnpm -w test', 'python -O -m pytest',
                    'npm exec -- jest', 'corepack pnpm -w test', 'nice -n 5 mvn verify']) {
                    const command = 'wsl.exe --distribution "Ubuntu Store" --cd /tmp ' + flag + ' ' + child;
                    assert.ok(getCompileCommandContractViolations(command).length > 0, command);
                    assert.throws(() => validateCompileGateCommand(command, 'test'), /test|Maven phase/i);
                }
            }
            assert.ok(getCompileCommandContractViolations('npm exec -- wsl -e go test').length > 0);
        });

        it('rejects inline native dispatch after WSL executable delegation', () => {
            assert.throws(() => validateCompileGateCommand('npm exec -- wsl --exec sh -c pytest', 'test'),
                /Unsupported executable command dispatch/i);
            for (const flag of ['--exec', '-e']) {
                for (const child of ['sh -c pytest', 'bash -lc pytest', 'cmd /c "npm test"',
                    'pwsh -Command pytest', 'env -S "pytest target"']) {
                    assert.throws(() => validateCompileGateCommand('wsl ' + flag + ' ' + child, 'test'),
                        /Unsupported executable command dispatch/i, child);
                }
            }
        });

        it('preserves WSL host option operands and literal delegated argv', () => {
            for (const option of ['-d', '--distribution', '--distribution-id', '-u', '--user', '--cd']) {
                for (const value of ['pytest', 'test', '--exec']) {
                    assert.deepEqual(getCompileCommandContractViolations(
                        'wsl ' + option + ' "' + value + '" --exec custom-builder --label "npm test" --exec pytest'
                    ), [], option + ' ' + value);
                }
            }
            for (const child of ['cmake --build "build folder"', 'ninja all', 'cargo build', 'dotnet build',
                'go build ./...', 'mvn -f "backend service/pom.xml" compile', './gradlew -p "test" assemble',
                'custom-builder "literal &&" "$PWD" "" --distribution pytest']) {
                assert.doesNotThrow(() => validateCompileGateCommand(
                    'wsl --distribution Ubuntu --user "store user" --cd "store folder" --shell-type standard --system -e ' + child,
                    'test'
                ), child);
            }
        });

        it('rejects test-bound Maven and Gradle goals while preserving WSL option data', () => {
            for (const child of ['mvn -f "test" compile', 'mvn -DskipTests package',
                './gradlew -p "test" assemble', './gradlew build -x test']) {
                assert.deepEqual(getCompileCommandContractViolations('wsl --exec ' + child), [], child);
            }
            for (const child of ['mvn -f "test" verify', 'mvn -f "-DskipTests" package',
                'mvn -DskipTests package test', './gradlew -p "test" test', './gradlew -p "--exclude-task=test" build']) {
                assert.ok(getCompileCommandContractViolations('wsl -e ' + child).length > 0, child);
            }
            assert.ok(getCompileCommandContractViolations('wsl -e mvn -DskipTests package && wsl -e mvn verify').length > 0);
        });

        it('rejects configured full-suite identities through transparent executable wrappers', () => {
            const suite = 'custom-suite --mode verify';
            for (const prefix of ['npm exec --', 'npx --yes', 'corepack npm exec --', 'env MODE=build nice -n 5',
                'wsl --exec', 'wsl --distribution Ubuntu -e npm exec --']) {
                for (const command of [prefix + ' ' + suite, 'npm run build && ' + prefix + ' ' + suite]) {
                    assert.ok(getCompileCommandContractViolations(command, { fullSuiteCommand: suite })
                        .includes('matches the configured full-suite validation command'), command);
                }
            }
            assert.deepEqual(getCompileCommandContractViolations('wsl -e custom-builder --label "' + suite + '"',
                { fullSuiteCommand: suite }), []);
            assert.ok(getCompileCommandContractViolations('wsl -e custom-suite "literal &&"',
                { fullSuiteCommand: 'custom-suite "literal &&"' }).length > 0);
        });

        it('rejects configured runner suites at intermediate executable boundaries', () => {
            const suite = 'npm exec -- custom-suite --mode verify';
            assert.ok(getCompileCommandContractViolations('corepack ' + suite, { fullSuiteCommand: suite })
                .includes('matches the configured full-suite validation command'));
            for (const prefix of ['corepack', 'env MODE=build nice -n 5', 'npx --yes', 'pnpm exec --',
                'wsl --distribution Ubuntu -e corepack']) {
                for (const command of [prefix + ' ' + suite, 'custom-builder && ' + prefix + ' ' + suite]) {
                    assert.throws(() => validateCompileGateCommand(command, 'test', { fullSuiteCommand: suite }),
                        /configured full-suite validation command/i, command);
                    assert.doesNotThrow(() => validateCompileGateCommand(command, 'test', {
                        fullSuiteCommand: suite, allowFullTestCompileCommand: true,
                        allowFullTestCompileCommandReason: 'explicit approved override'
                    }), command);
                }
            }
            for (const command of ['node build.js "' + suite + '"',
                'env --chdir "npm" custom-builder exec -- custom-suite --mode verify',
                'wsl --exec custom-builder --label "' + suite + '"']) {
                assert.deepEqual(getCompileCommandContractViolations(command, { fullSuiteCommand: suite }), [], command);
            }
        });

        it('rejects configured executable-string suites at intermediate runner boundaries', () => {
            assert.ok(getCompileCommandContractViolations('corepack npm exec --call custom-suite',
                { fullSuiteCommand: 'npm exec --call custom-suite' })
                .includes('matches the configured full-suite validation command'));
            for (const suite of ['npm exec --call custom-suite', 'npm x -c custom-suite', 'npx -c custom-suite',
                'pnpm -c exec custom-suite', 'pnpx -c custom-suite']) {
                for (const prefix of ['corepack', 'env MODE=build nice -n 5', 'wsl --exec corepack']) {
                    const command = prefix + ' ' + suite;
                    assert.throws(() => validateCompileGateCommand(command, 'test', { fullSuiteCommand: suite }),
                        /configured full-suite validation command/i, command);
                }
                assert.deepEqual(getCompileCommandContractViolations('custom-builder "' + suite + '"',
                    { fullSuiteCommand: suite }), [], suite);
            }
        });

        it('rejects ambiguous or unsupported WSL host syntax with executable-boundary guidance', () => {
            assert.throws(() => validateCompileGateCommand('wsl --cd', 'test'), /wsl --exec.*trusted wrapper/i);
            for (const command of ['wsl', 'wsl go build', 'wsl --exec', 'wsl -e ""', 'wsl --exec "~"',
                'wsl -d', 'wsl --distribution "" --exec builder', 'wsl -E go build', 'wsl --Exec go build',
                'wsl --unknown --exec builder', 'wsl --exec=builder', 'wsl --distribution=Ubuntu --exec builder']) {
                assert.throws(() => validateCompileGateCommand(command, 'test'), /wsl --exec.*trusted wrapper/i, command);
            }
        });

        it('preserves unquoted literal punctuation in direct compile arguments', () => {
            assert.doesNotThrow(() => validateCompileGateCommand('node build.js $NAME folder(name) `value` $(value)', 'test'));
            assert.doesNotThrow(() => validateCompileGateCommand(
                'node build.js $NAME folder(name) `value` $(value) && npm run build', 'test'
            ));
        });

        it('checks the configured full-suite command inside every chain segment', () => {
            assert.ok(getCompileCommandContractViolations('npm run build && npm run verify', {
                fullSuiteCommand: 'npm run verify'
            }).some((violation) => violation.includes('configured full-suite')));
        });

        for (const command of ['npm run build | npm run typecheck', 'npm run build;', 'npm run build &&',
            'npm run build\nnpm run typecheck', 'FOO=bar npm run build', 'npm run build > output.log']) {
            it('rejects unsupported compile configuration: ' + JSON.stringify(command), () => {
                assert.throws(() => validateCompileGateCommand(command, 'test'), /Unsupported command syntax|empty command/i);
            });
        }
    });

    describe('getCompileCommandProfile', () => {
        it('detects maven compile', () => {
            const result = getCompileCommandProfile('mvn clean compile');
            assert.equal(result.kind, 'compile');
            assert.equal(result.strategy, 'maven');
            assert.equal(result.label, 'maven');
        });

        it('detects gradle compile', () => {
            const result = getCompileCommandProfile('./gradlew build');
            assert.equal(result.strategy, 'gradle');
            assert.equal(result.label, 'gradle');
        });

        it('detects npm build as node strategy', () => {
            const result = getCompileCommandProfile('npm run build');
            assert.equal(result.strategy, 'node');
            assert.equal(result.label, 'node-build');
        });

        it('detects test commands', () => {
            const result = getCompileCommandProfile('npm run test');
            assert.equal(result.kind, 'test');
            assert.equal(result.label, 'test');
            assert.equal(result.failure_profile, 'test_failure_console');
            assert.equal(result.success_profile, 'test_success_console');
        });

        it('detects pytest as test', () => {
            const result = getCompileCommandProfile('pytest -q tests/');
            assert.equal(result.kind, 'test');
        });

        it('detects eslint as lint', () => {
            const result = getCompileCommandProfile('eslint src/');
            assert.equal(result.kind, 'lint');
            assert.equal(result.failure_profile, 'lint_failure_console');
        });

        it('detects cargo build', () => {
            const result = getCompileCommandProfile('cargo build --release');
            assert.equal(result.strategy, 'cargo');
        });

        it('detects dotnet build', () => {
            const result = getCompileCommandProfile('dotnet build');
            assert.equal(result.strategy, 'dotnet');
        });

        it('detects go build', () => {
            const result = getCompileCommandProfile('go build ./...');
            assert.equal(result.strategy, 'go');
        });

        it('falls back to generic for unknown commands', () => {
            const result = getCompileCommandProfile('make all');
            assert.equal(result.kind, 'compile');
            assert.equal(result.strategy, 'generic');
        });

        it('detects mvn test as test', () => {
            const result = getCompileCommandProfile('mvn test');
            assert.equal(result.kind, 'test');
        });

        it('detects Windows wrapper test commands as test', () => {
            const result = getCompileCommandProfile('.\\gradlew.bat test');
            assert.equal(result.kind, 'test');
        });

        it('detects cargo test as test', () => {
            const result = getCompileCommandProfile('cargo test');
            assert.equal(result.kind, 'test');
        });

        it('detects ruff check as lint', () => {
            const result = getCompileCommandProfile('ruff check src/');
            assert.equal(result.kind, 'lint');
        });

        it('detects tsc --noEmit as lint', () => {
            const result = getCompileCommandProfile('tsc --noEmit');
            assert.equal(result.kind, 'lint');
        });
    });

    describe('getCompileCommands', () => {
        it('extracts commands from markdown section', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '# Commands',
                '',
                '### Compile Gate (Mandatory)',
                '',
                '```bash',
                'npm run build',
                'npm run lint',
                '```',
                '',
                '### Other Section',
                'not a command',
            ].join('\n'), 'utf8');

            const commands = getCompileCommands(filePath);
            assert.deepEqual(commands, ['npm run build', 'npm run lint']);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('extracts commands from markdown section with CRLF line endings', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '# Commands',
                '',
                '### Compile Gate (Mandatory)',
                '',
                '```bash',
                'npm run build',
                '```',
                ''
            ].join('\r\n'), 'utf8');

            const commands = getCompileCommands(filePath);

            assert.deepEqual(commands, ['npm run build']);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('throws when section is missing', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, '# Other content\nHello\n', 'utf8');

            assert.throws(() => getCompileCommands(filePath), /Section.*not found/);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('rejects unresolved placeholders', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '### Compile Gate (Mandatory)',
                '```',
                '<your-command-here>',
                '```',
            ].join('\n'), 'utf8');

            assert.throws(() => getCompileCommands(filePath), /placeholder.*unresolved/i);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('rejects unconfigured sentinel unless explicitly allowed for human-visible contract validation', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '### Compile Gate (Mandatory)',
                '```',
                UNCONFIGURED_COMPILE_GATE_COMMAND,
                '```',
            ].join('\n'), 'utf8');

            assert.throws(() => getCompileCommands(filePath), /Compile command is unconfigured/i);
            assert.deepEqual(
                getCompileCommands(filePath, { allowUnconfiguredSentinel: true }),
                [UNCONFIGURED_COMPILE_GATE_COMMAND]
            );
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('rejects full-suite test commands in compile gate section', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '### Compile Gate (Mandatory)',
                '```',
                'npm test',
                '```',
            ].join('\n'), 'utf8');

            assert.throws(() => getCompileCommands(filePath), /must not run the full test suite/i);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('rejects commands matching configured full-suite validation command', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '### Compile Gate (Mandatory)',
                '```',
                'npm run verify',
                '```',
            ].join('\n'), 'utf8');

            assert.throws(
                () => getCompileCommands(filePath, { fullSuiteCommand: 'npm run verify' }),
                /matches the configured full-suite validation command/i
            );
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('allows approved full-test compile command override with reason', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '### Compile Gate (Mandatory)',
                '```',
                'npm test',
                '```',
            ].join('\n'), 'utf8');

            const commands = getCompileCommands(filePath, {
                allowFullTestCompileCommand: true,
                allowFullTestCompileCommandReason: 'operator-approved legacy repository has no separate build command'
            });

            assert.deepEqual(commands, ['npm test']);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
    });

    describe('getCompileCommandContractViolations', () => {
        it('flags Maven and Gradle test-bound lifecycle commands', () => {
            assert.ok(getCompileCommandContractViolations('mvn package').some((item) => item.includes('Maven phase')));
            assert.ok(getCompileCommandContractViolations('./gradlew build').some((item) => item.includes("Gradle task 'build'")));
            assert.deepEqual(getCompileCommandContractViolations('./mvnw compile'), []);
            assert.deepEqual(getCompileCommandContractViolations('./gradlew assemble'), []);
            assert.deepEqual(getCompileCommandContractViolations('./gradlew build -x test'), []);
            assert.deepEqual(getCompileCommandContractViolations('./gradlew :app:build --exclude-task :app:test'), []);
            assert.deepEqual(getCompileCommandContractViolations('./gradlew :app:build -x :app:test'), []);
            assert.ok(getCompileCommandContractViolations('./gradlew :app:build --exclude-task :other:test').some((item) => item.includes("Gradle task 'build'")));
            assert.ok(getCompileCommandContractViolations('./gradlew build --exclude-task :app:test').some((item) => item.includes("Gradle task 'build'")));
        });
    });

    describe('getOutputStats', () => {
        it('counts warnings and errors', () => {
            const lines = [
                'Compiling...',
                'WARNING: deprecated API',
                'ERROR: missing module',
                'warning: unused var',
                'Done'
            ];
            const { warningLines, errorLines } = getOutputStats(lines);
            assert.equal(warningLines, 2);
            assert.equal(errorLines, 1);
        });

        it('returns zero for clean output', () => {
            const { warningLines, errorLines } = getOutputStats(['OK', 'Done']);
            assert.equal(warningLines, 0);
            assert.equal(errorLines, 0);
        });
    });

    describe('getWorkspaceSnapshot', () => {
        it('recovers from adversarial absolute and traversal generated-runtime paths as ignored evidence', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-generated-runtime-'));
            const repoRoot = path.join(tempDir, 'repo');
            const appPath = path.join(repoRoot, 'src', 'app.ts');
            const ignoredPaths = [
                '../outside/runtime/reviews/T-983-2-code-review.json',
                '../runtime/reviews/T-983-2-traversal-prefixed.json',
                'Z:/missing/root/runtime/task-events/T-983-2.jsonl'
            ];
            const explicitPaths = [
                '../outside/runtime/reviews/T-983-2-code-review.json',
                'src/../../runtime/reviews/T-983-2-traversal-prefixed.json',
                'Z:/missing/root/runtime/task-events/T-983-2.jsonl'
            ];

            try {
                fs.mkdirSync(path.dirname(appPath), { recursive: true });
                fs.writeFileSync(appPath, 'export const value = 1;\n', 'utf8');
                initGitRepo(repoRoot);
                fs.writeFileSync(appPath, 'export const value = 2;\n', 'utf8');

                const snapshot = getWorkspaceSnapshot(
                    repoRoot,
                    'explicit_changed_files',
                    false,
                    ['src/app.ts', ...explicitPaths]
                );

                assert.deepEqual(snapshot.authorized_files, ['src/app.ts']);
                assert.deepEqual(snapshot.changed_files, ['src/app.ts']);
                assert.deepEqual(snapshot.ignored_generated_runtime_files, ignoredPaths);
                assert.equal(snapshot.ignored_generated_runtime_files_count, ignoredPaths.length);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('fails explicit snapshots closed when canonical Git classification is unavailable', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-no-git-'));

            try {
                assert.throws(
                    () => getWorkspaceSnapshot(
                        repoRoot,
                        'explicit_changed_files',
                        false,
                        ['Z:/missing/root/runtime/task-events/T-983-2.jsonl']
                    ),
                    /not a git repository|git .* failed/iu
                );
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });

        it('collects changed files when repo root and file paths contain spaces', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const repoRoot = path.join(tempDir, 'repo with spaces');
            const srcDir = path.join(repoRoot, 'src');
            const changedFilePath = path.join(srcDir, 'app with spaces.ts');

            try {
                fs.mkdirSync(srcDir, { recursive: true });
                fs.writeFileSync(changedFilePath, 'export const value = 1;\n', 'utf8');
                initGitRepo(repoRoot);

                fs.writeFileSync(changedFilePath, 'export const value = 2;\n', 'utf8');

                const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', false, []);
                assert.ok(snapshot.changed_files.includes('src/app with spaces.ts'));
                assert.equal(snapshot.changed_files_count, 1);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('retains untracked binary scope and content bindings without counting binary text lines', (context) => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-binary-'));
            context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
            initGitRepo(repoRoot);
            const fixturePath = path.join(repoRoot, 'fixture.tgz');
            fs.writeFileSync(fixturePath, Buffer.from('binary\0payload\nline\n'));
            for (const source of ['git_auto', 'explicit_changed_files']) {
                const snapshot = getWorkspaceSnapshot(repoRoot, source, true, ['fixture.tgz']);
                assert.deepEqual(snapshot.changed_files, ['fixture.tgz']);
                assert.equal(snapshot.changed_lines_total, 0);
                assert.deepEqual(snapshot.changed_file_stats['fixture.tgz'], { additions: 0, deletions: 0, changed_lines: 0 });
                fs.writeFileSync(fixturePath, Buffer.from([0xff, 0x0a, 0x61]));
                const modified = getWorkspaceSnapshot(repoRoot, source, true, ['fixture.tgz']);
                assert.equal(modified.changed_lines_total, 0);
                assert.notEqual(modified.scope_content_sha256, snapshot.scope_content_sha256);
                fs.writeFileSync(fixturePath, Buffer.from('binary\0payload\nline\n'));
            }
        });

        it('ignores generated orchestrator lock directories in workspace scope', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-locks-'));
            const repoRoot = path.join(tempDir, 'repo');
            const srcDir = path.join(repoRoot, 'src');

            try {
                fs.mkdirSync(srcDir, { recursive: true });
                fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export const value = 1;\n', 'utf8');
                initGitRepo(repoRoot);

                fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export const value = 2;\n', 'utf8');
                fs.mkdirSync(path.join(repoRoot, '.scripts-build.lock'), { recursive: true });
                fs.writeFileSync(path.join(repoRoot, '.scripts-build.lock', 'owner.json'), '{}\n', 'utf8');
                fs.mkdirSync(path.join(repoRoot, '.node-build.lock'), { recursive: true });
                fs.writeFileSync(path.join(repoRoot, '.node-build.lock', 'owner.json'), '{}\n', 'utf8');

                const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);

                assert.deepEqual(snapshot.changed_files, ['src/app.ts']);
                assert.equal(snapshot.changed_files_count, 1);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('buildScopeContentFingerprint', () => {
        it('keeps staged content stable until the index changes', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-staged-fingerprint-'));
            const trackedPath = path.join(repoRoot, 'src', 'app.ts');
            try {
                fs.mkdirSync(path.dirname(trackedPath), { recursive: true });
                fs.writeFileSync(trackedPath, 'export const value = "baseline";\n', 'utf8');
                initGitRepo(repoRoot);

                fs.writeFileSync(trackedPath, 'export const value = "alpha";\n', 'utf8');
                runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
                const stagedAlpha = buildScopeContentFingerprint(
                    repoRoot,
                    'git_staged_only',
                    ['src/app.ts']
                );

                fs.writeFileSync(trackedPath, 'export const value = "bravo";\n', 'utf8');
                assert.equal(
                    buildScopeContentFingerprint(repoRoot, 'git_staged_only', ['src/app.ts']),
                    stagedAlpha
                );

                runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
                assert.notEqual(
                    buildScopeContentFingerprint(repoRoot, 'git_staged_only', ['src/app.ts']),
                    stagedAlpha
                );
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });
    });

    describe('extractNewPathFromNumstat', () => {
        it('returns plain path unchanged', () => {
            assert.equal(extractNewPathFromNumstat('src/file.ts'), 'src/file.ts');
        });

        it('extracts new path from simple rename', () => {
            assert.equal(extractNewPathFromNumstat('old.ts => new.ts'), 'new.ts');
        });

        it('extracts new path from brace-style rename', () => {
            assert.equal(extractNewPathFromNumstat('{old => new}/file.ts'), 'new/file.ts');
        });

        it('extracts new path from prefixed brace rename', () => {
            assert.equal(extractNewPathFromNumstat('src/{old-name => new-name}.ts'), 'src/new-name.ts');
        });

        it('handles empty rename target in braces', () => {
            assert.equal(extractNewPathFromNumstat('{old => }/file.ts'), '/file.ts');
        });

        it('handles path with no rename arrow', () => {
            assert.equal(extractNewPathFromNumstat('path/to/file with spaces.ts'), 'path/to/file with spaces.ts');
        });
    });
});
