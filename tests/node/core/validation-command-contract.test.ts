import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspectValidationCommand, type ValidationCommandPurpose } from '../../../src/core/validation-command-contract';
import { validateCompileGateCommand } from '../../../src/gates/compile/compile-gate';

const purposes: ValidationCommandPurpose[] = ['compile', 'test', 'validation'];

describe('ordinary validation command projection', () => {
    it('preserves declared purpose and literal invocation independently of runner names', () => {
        for (const command of ['proof-driver --scenario refund', 'loom build', 'gradle build', 'mvn package',
            'pwsh -NoProfile -File tools/suite.ps1', 'bash tools/suite.sh --scenario refund',
            'mksh tools/suite.sh --scenario refund', 'yash tools/suite.sh --scenario refund',
            'bash +e tools/suite.sh', 'mksh -- tools/suite.sh -c literal',
            '.\\mvnw.cmd test', '.\\gradlew.bat test', 'tools/suite.fish refund', 'npm run suite']) {
            for (const purpose of purposes) {
                const result = inspectValidationCommand(command, purpose);
                assert.equal(result.supported, true, `${purpose}: ${command}`);
                assert.equal(result.descriptor?.purpose, purpose);
                assert.equal(result.descriptor?.invocations.length, 1);
            }
        }
    });

    it('keeps opaque selectors and source-program arguments as data', () => {
        for (const purpose of purposes) {
            const result = inspectValidationCommand('proof-driver --scenario "javascript:refund" "a;b>c<d" ""', purpose);
            assert.deepEqual(result.descriptor?.invocations, [{ executable: 'proof-driver',
                argv: ['--scenario', 'javascript:refund', 'a;b>c<d', ''] }]);
            assert.equal(inspectValidationCommand('pwsh -File tools/suite.ps1 -Command literal', purpose).supported, true);
            assert.equal(inspectValidationCommand('mksh tools/suite.sh +e -c literal', purpose).supported, true);
        }
    });

    it('rejects actual inline dispatch and shell-dependent syntax in every stage', () => {
        for (const command of ['sh -c "echo unsafe"', 'mksh -c "echo unsafe"', 'yash -c "echo unsafe"',
            'pdksh -c "echo unsafe"', 'elvish -c "echo unsafe"', 'rc -c "echo unsafe"',
            'mksh +e -c "echo unsafe"', 'dash +e -c "echo unsafe"', 'yash +o noglob -c "echo unsafe"',
            'mksh +e', 'mksh --', 'mksh -unknown "unresolved operand"',
            'npm exec --call "mksh +e -c unsafe"',
            'node -e "process.exit(0)"', 'python -Bc "print(0)"', 'pwsh -EncodedCommand YQ==',
            'env -S "proof-driver refund"', 'nice sh -c "echo unsafe"', 'wsl --exec sh -c "echo unsafe"',
            'npm exec --call "builder | tests"', 'builder > report', 'builder || fallback', 'builder; fallback',
            'builder\nother', 'builder "unterminated', 'MODE=test builder']) {
            for (const purpose of purposes) assert.equal(inspectValidationCommand(command, purpose).supported, false, command);
        }
    });

    it('bounds invocation data and keeps the existing explicit compile chain capability', () => {
        for (const purpose of purposes) {
            assert.equal(inspectValidationCommand('builder ' + 'x'.repeat(64 * 1024), purpose).supported, false);
            assert.equal(inspectValidationCommand('builder ' + Array(257).fill('arg').join(' '), purpose).supported, false);
            assert.equal(inspectValidationCommand('builder && verifier', purpose).supported, false);
        }
        const chain = inspectValidationCommand('builder "literal &&" && verifier', 'compile', { allowConjunction: true });
        assert.deepEqual(chain.descriptor?.invocations, [{ executable: 'builder', argv: ['literal &&'] }, { executable: 'verifier', argv: [] }]);
        assert.equal(inspectValidationCommand(Array(33).fill('builder').join(' && '), 'compile', { allowConjunction: true }).supported, false);
    });

    it('rejects declared stage mismatches and configured-suite identity independently of tool names', () => {
        assert.doesNotThrow(() => validateCompileGateCommand('proof-driver --scenario Refund', 'compile slot', {
            fullSuiteCommand: 'proof-driver --scenario refund'
        }));
        assert.throws(() => validateCompileGateCommand('proof-driver build', 'compile slot', { purpose: 'test' }), /declared purpose/);
        assert.throws(() => validateCompileGateCommand('proof-driver suite', 'compile slot', {
            fullSuiteCommand: 'proof-driver suite'
        }), /matches the configured full-suite/);
        assert.throws(() => validateCompileGateCommand('node -e "0"', 'compile slot', {
            allowFullTestCompileCommand: true, allowFullTestCompileCommandReason: 'approved mixed command'
        }), /inline/);
    });
});
