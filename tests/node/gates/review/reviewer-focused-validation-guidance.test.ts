import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';
import { inspectReviewerFocusedValidationCommand } from '../../../../src/gates/review/review-findings-schema';
import { buildReviewerFocusedSelfValidationContractLines } from '../../../../src/gates/review/reviewer-execution-contract';
import {
    REVIEWER_INLINE_INTERPRETER_EXAMPLES,
    hasReviewerInlineInterpreterOption
} from '../../../../src/gates/review/reviewer-focused-validation-policy';
import {
    buildFocusedIntermediateValidationEvidence,
    buildFocusedIntermediateValidationEvidenceMarkdown
} from '../../../../src/gates/review-context/review-context-focused-intermediate-evidence';

const TASK_ID = 'T-180-GUIDANCE';
const TARGET = 'tests/node/focused.test.ts';
const COMMAND = `node scripts/node-foundation/build-scripts.cjs test.js ${TARGET}`;

function sha256(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeFixture() {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-reviewer-guidance-'));
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests', 'node'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, TARGET), 'export {};\n', 'utf8');
    const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
    fs.writeFileSync(preflightPath, JSON.stringify({ task_id: TASK_ID, changed_files: [TARGET] }), 'utf8');
    const coverageContract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: [TARGET] });
    appendTaskEvent(bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'Current task.', {});
    return {
        repoRoot, bundleRoot, reviewsRoot, preflightPath, coverageContract,
        preflightSha256: sha256(preflightPath)
    };
}

type Fixture = ReturnType<typeof makeFixture>;

function appendEvidence(fixture: Fixture, options: {
    command?: string;
    artifactTaskId?: string;
    preflightSha256?: string;
    coverageSha256?: string;
    tamperOutput?: boolean;
} = {}): void {
    const command = options.command ?? COMMAND;
    const outputPath = path.join(fixture.reviewsRoot, `${crypto.randomUUID()}.log`);
    const artifactPath = path.join(fixture.reviewsRoot, `${crypto.randomUUID()}.json`);
    fs.writeFileSync(outputPath, 'Focused fixture check passed.\n', 'utf8');
    const outputSha256 = sha256(outputPath);
    const outputSize = fs.statSync(outputPath).size;
    const bindings = {
        preflight_path: fixture.preflightPath,
        preflight_sha256: options.preflightSha256 ?? fixture.preflightSha256,
        coverage_contract_sha256: options.coverageSha256 ?? fixture.coverageContract.contract_sha256
    };
    fs.writeFileSync(artifactPath, JSON.stringify({
        schema_version: 1,
        task_id: options.artifactTaskId ?? TASK_ID,
        command_source: 'targeted-test',
        command,
        status: 'PASSED',
        exit_code: 0,
        output_artifact: outputPath,
        output_artifact_sha256: outputSha256,
        output_artifact_size_bytes: outputSize,
        ...bindings
    }), 'utf8');
    appendTaskEvent(fixture.bundleRoot, TASK_ID, 'INTERMEDIATE_COMMAND_RUN', 'PASSED', 'Focused fixture.', {
        command_source: 'targeted-test',
        command,
        exit_code: 0,
        artifact_path: artifactPath,
        artifact_sha256: sha256(artifactPath),
        output_artifact_path: outputPath,
        output_artifact_sha256: outputSha256,
        output_artifact_size_bytes: outputSize,
        ...bindings
    });
    if (options.tamperOutput) fs.appendFileSync(outputPath, 'tampered\n', 'utf8');
}

function buildEvidence(fixture: Fixture, taskId: string | null = TASK_ID) {
    return buildFocusedIntermediateValidationEvidence({
        repoRoot: fixture.repoRoot,
        reviewsRoot: fixture.reviewsRoot,
        taskId,
        reviewType: 'code',
        changedFiles: [TARGET],
        preflightPath: fixture.preflightPath,
        preflightSha256: fixture.preflightSha256,
        coverageContract: fixture.coverageContract
    });
}

function withFixture<T>(run: (fixture: Fixture) => T): T {
    const fixture = makeFixture();
    try {
        return run(fixture);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
}

describe('reviewer focused validation policy', () => {
    for (const prefix of REVIEWER_INLINE_INTERPRETER_EXAMPLES) {
        it(`documents and rejects ${prefix} inline programs`, () => {
            const command = `${prefix} "compileAndLoadTest()" ${TARGET}`;
            const inspection = inspectReviewerFocusedValidationCommand(command);
            assert.equal(inspection.syntax_supported, false);
            assert.ok(inspection.violations.length > 0);
            const [program, option] = prefix.split(' ');
            assert.equal(hasReviewerInlineInterpreterOption(program, [program, option]), true);
            assert.ok(buildReviewerFocusedSelfValidationContractLines().join('\n').includes(prefix));
        });
    }

    it('rejects inline programs following runtime options and the reported custom TypeScript loader', () => {
        for (const command of [
            `node --no-warnings -e "ts.transpileModule(source); module._compile(output, filename)" ${TARGET}`,
            `node --eval="compileAndLoadTest()" ${TARGET}`,
            'python3 -B -c "exec(compile(source, filename, \'exec\'))" tests/test_contract.py',
            'php -d display_errors=1 -r "eval($source);" tests/check.php'
        ]) {
            const inspection = inspectReviewerFocusedValidationCommand(command);
            assert.equal(inspection.syntax_supported, false);
            assert.ok(inspection.violations.length > 0);
        }
    });

    it('preserves ordinary one-target test and validation invocations across supported runners', () => {
        for (const command of [
            `node --test ${TARGET}`,
            `node.exe --test ${TARGET}`,
            COMMAND,
            'pytest tests/test_contract.py',
            'python -m pytest tests/test_contract.py',
            'bash tests/check.sh',
            'pwsh tests/check.ps1'
        ]) {
            assert.deepEqual(inspectReviewerFocusedValidationCommand(command).violations, [], command);
        }
        const guidance = buildReviewerFocusedSelfValidationContractLines().join('\n');
        assert.ok(guidance.includes('Normal runtime compilation or transformation'));
        assert.ok(guidance.includes('Do not create temporary runner scripts'));
        assert.ok(guidance.includes('absent command hint is not proof'));
    });

    it('keeps absolute paths, traversal, multi-target runs, mutations, broad suites and shell chains rejected', () => {
        for (const command of [
            'node --test ../outside.test.ts',
            'node --test /tmp/outside.test.ts',
            'node --test C:\\outside.test.ts',
            `node --test ${TARGET} tests/node/second.test.ts`,
            'node --test tests/node',
            'npm test',
            `node --test ${TARGET} && node --test ${TARGET}`,
            `vitest run --update ${TARGET}`
        ]) {
            assert.equal(inspectReviewerFocusedValidationCommand(command).syntax_supported, false, command);
        }
    });
});

describe('authenticated reviewer command hints', () => {
    it('passes an exact accepted command with native source bindings to JSON and Markdown without executing it', () => {
        const result = withFixture((fixture) => {
            const sentinel = path.join(fixture.repoRoot, 'must-not-exist.txt');
            fs.writeFileSync(path.join(fixture.repoRoot, TARGET),
                `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unexpected');\n`, 'utf8');
            appendEvidence(fixture);
            appendEvidence(fixture);
            const evidence = buildEvidence(fixture);
            assert.equal(evidence.status, 'AVAILABLE');
            assert.equal(evidence.entries.length, 2);
            const hints = evidence.reviewer_command_hints!;
            assert.equal(hints.status, 'AVAILABLE');
            assert.equal(hints.commands.length, 1);
            const hint = hints.commands[0];
            assert.equal(hint.command, COMMAND);
            assert.equal(hint.target, TARGET);
            assert.deepEqual(inspectReviewerFocusedValidationCommand(hint.command, fixture.repoRoot).violations, []);
            assert.ok(evidence.entries.some((entry) => (
                entry.event_task_sequence === hint.source_event_sequence
                && entry.artifact_sha256 === hint.source_artifact_sha256
            )));
            assert.ok(buildFocusedIntermediateValidationEvidenceMarkdown(evidence).join('\n').includes(COMMAND));
            return { evidence, sentinelExists: fs.existsSync(sentinel) };
        });
        assert.equal(result.sentinelExists, false);
        assert.equal(result.evidence.reviewer_command_hints!.commands.length, 1);
    });

    it('keeps authenticated multi-target PASS history while declining to advertise it as a focused invocation', () => {
        const evidence = withFixture((fixture) => {
            fs.writeFileSync(path.join(fixture.repoRoot, 'tests/node/second.test.ts'), 'export {};\n', 'utf8');
            appendEvidence(fixture, { command: `${COMMAND} tests/node/second.test.ts` });
            return buildEvidence(fixture);
        });
        assert.equal(evidence.entries.length, 1);
        assert.equal(evidence.reviewer_command_hints!.status, 'NOT_AVAILABLE');
        assert.equal(evidence.reviewer_command_hints!.commands.length, 0);
        assert.equal(evidence.reviewer_command_hints!.rejected_command_count, 1);
    });

    for (const [name, options] of [
        ['foreign task', { artifactTaskId: 'T-FOREIGN' }],
        ['preflight mismatch', { preflightSha256: 'f'.repeat(64) }],
        ['coverage mismatch', { coverageSha256: 'e'.repeat(64) }],
        ['tampered output', { tamperOutput: true }]
    ] as const) {
        it(`does not offer a command from ${name} evidence`, () => {
            withFixture((fixture) => {
                appendEvidence(fixture, options);
                const evidence = buildEvidence(fixture);
                assert.equal(evidence.entries.length, 0);
                assert.equal(evidence.reviewer_command_hints!.status, 'NOT_AVAILABLE');
                assert.equal(evidence.reviewer_command_hints!.commands.length, 0);
                assert.ok(evidence.warnings.length > 0);
            });
        });
    }

    it('does not invent a command for missing, stale-cycle or absent task evidence', () => {
        const evidence = withFixture((fixture) => {
            for (const taskId of [TASK_ID, null]) {
                assert.equal(buildEvidence(fixture, taskId).reviewer_command_hints!.commands.length, 0);
            }
            appendEvidence(fixture);
            appendTaskEvent(fixture.bundleRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', 'New cycle.', {});
            return buildEvidence(fixture);
        });
        assert.equal(evidence.entries.length, 0);
        const markdown = buildFocusedIntermediateValidationEvidenceMarkdown(evidence).join('\n');
        assert.ok(markdown.includes('No exact validator-compatible command'));
        assert.ok(markdown.includes('Absence is not a finding'));
        assert.ok(!markdown.includes('- Validator-compatible command:'));
    });

    it('reads legacy evidence blocks without requiring or inventing command hints', () => {
        withFixture((fixture) => {
            const evidence = buildEvidence(fixture);
            delete evidence.reviewer_command_hints;
            assert.ok(!buildFocusedIntermediateValidationEvidenceMarkdown(evidence).join('\n')
                .includes('Reviewer Focused Command Hints'));
        });
    });
});

