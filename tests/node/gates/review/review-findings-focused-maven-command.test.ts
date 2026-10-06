import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';

import { REVIEW_FINDINGS_SCHEMA_VERSION, validateReviewFindingsReport } from '../../../../src/gates/review/review-findings-schema';
import { buildReviewRemediationReviewContract } from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import {
    attestReviewerInvocationForTest, buildNoFindingsJsonReviewReport, createTempRepo,
    runCliWithCapturedOutput, seedPromptBoundReviewFixture
} from '../../cli/commands/gates/review-result/gates-command-review-result-fixtures';

const TASK_ID = 'T-177-maven-parser';
const SOURCE = 'src/parser.ts';
const PROJECT = 'tests/maven project';
const HASH = 'a'.repeat(64);
const EXECUTION_CONTRACT = buildReviewRemediationReviewContract({
    taskId: TASK_ID, reviewType: 'code', preflightSha256: HASH, fullReviewScope: [SOURCE]
});

function createMavenFixture(context: TestContext, project = PROJECT, native = false): { repoRoot: string; target: string; pom: string } {
    const temporaryParent = fs.realpathSync(os.tmpdir());
    const repoRoot = native ? createTempRepo(context) : fs.mkdtempSync(path.join(temporaryParent, 'garda-t177-'));
    if (!native) context.after(() => {
        assert.equal(path.dirname(repoRoot), temporaryParent);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
    const projectPrefix = project ? `${project}/` : '';
    const target = `${projectPrefix}src/test/java/example/ExampleTest.java`;
    const pom = `${projectPrefix}pom.xml`;
    fs.mkdirSync(path.dirname(path.join(repoRoot, target)), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, target), 'package example; public class ExampleTest {}\n');
    fs.writeFileSync(path.join(repoRoot, pom), '<project><modelVersion>4.0.0</modelVersion></project>\n');
    fs.writeFileSync(path.join(repoRoot, SOURCE), 'export const parserFixture = true;\n');
    return { repoRoot, target, pom };
}

function focusedReport(command: string, target: string) {
    const evidence = [{ location: `${SOURCE}:1`, observation: `${TASK_ID} changed parser validates ${target}.` }];
    return {
        schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
        task_id: TASK_ID, review_type: 'code', review_context_sha256: HASH, tree_state_sha256: HASH,
        validation_notes: [{
            id: 'N-001', topic: 'focused-self-validation',
            note: 'Parser-only fixture for the command selecting one Java test file.',
            command, command_outcome: 'passed', diagnostics: 'Fixture selected one ExampleTest class with 1 test and 0 failures.',
            finding_ids: [] as string[], evidence
        }],
        coverage_ledger: {
            coverage_contract_sha256: HASH,
            entries: [{ obligation_id: 'FILE-001', evidence, finding_ids: [] as string[] }]
        },
        review_execution: {
            mode: 'FULL', contract_sha256: EXECUTION_CONTRACT.contract_sha256,
            covered_delta_targets: [], inspected_prior_finding_ids: []
        },
        findings: {
            critical: [], high: [], low: [],
            medium: [] as Array<{
                id: string; title: string; description: string;
                evidence: typeof evidence; coverage_obligation_ids: string[];
            }>
        },
        residual_risks: [], reviewer_notes: []
    };
}

function createParserOnlyCompiledClass(fixture: ReturnType<typeof createMavenFixture>, relativeClass = 'example/ExampleTest.class'): string {
    const compiledClass = path.join(fixture.repoRoot, path.dirname(fixture.pom), 'target/test-classes', relativeClass);
    fs.mkdirSync(path.dirname(compiledClass), { recursive: true });
    // Filesystem/parser fixture only; these bytes are never presented as executable Java bytecode.
    fs.writeFileSync(compiledClass, 'parser-only compiled-class placeholder');
    return compiledClass;
}

function validateCommand(command: string, fixture: ReturnType<typeof createMavenFixture>) {
    return validateReviewFindingsReport(focusedReport(command, fixture.target), {
        expectedTaskId: TASK_ID, expectedReviewType: 'code', expectedReviewContextSha256: HASH,
        expectedTreeStateSha256: HASH, expectedChangedFilePaths: [SOURCE],
        expectedCoverageObligationIds: ['FILE-001'], expectedReviewExecutionContract: EXECUTION_CONTRACT,
        repoRoot: fixture.repoRoot
    });
}

function resolveMavenTargetsInChild(fixture: ReturnType<typeof createMavenFixture>) {
    const script = `
        const adapter = require(process.argv[1]);
        const command = adapter.parseMavenFocusedCommand(['mvn', '-o', '-f', process.argv[3], '-Dtest=ExampleTest', 'test']);
        process.stdout.write(JSON.stringify(adapter.resolveMavenFocusedTargets(command, process.argv[2], () => true)));
    `;
    return spawnSync(process.execPath, [
        '-e', script, require.resolve('../../../../src/gates/review/review-focused-command-maven'),
        fixture.repoRoot, fixture.pom
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
}

test('Maven bounds processing of deeply nested plugin directory elements', (context) => {
    const fixture = createMavenFixture(context);
    const nesting = 25000;
    fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom),
        '<project><build><plugins><plugin><configuration>' + '<directory>'.repeat(nesting)
        + '</directory>'.repeat(nesting) + '</configuration></plugin></plugins></build></project>');
    const execution = resolveMavenTargetsInChild(fixture);
    assert.equal(execution.status, 0, String(execution.error || execution.stderr));
    assert.deepEqual(JSON.parse(execution.stdout), [fixture.target]);
});

test('Maven rejects repeated unterminated XML comments within bounded processing time', (context) => {
    const fixture = createMavenFixture(context);
    fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom), '<project>' + '<!--'.repeat(200000) + '</project>');
    const execution = resolveMavenTargetsInChild(fixture);
    assert.equal(execution.status, 0, String(execution.error || execution.stderr));
    assert.deepEqual(JSON.parse(execution.stdout), []);
});

test('Maven consumes offline, project and selector operands without counting the POM as a test target', (context) => {
    const fixture = createMavenFixture(context);
    createParserOnlyCompiledClass(fixture);
    const forms = [
        `-o -f "${fixture.pom}" -Dtest=ExampleTest test`,
        `--offline --file="${fixture.pom}" -Dtest=example.ExampleTest test`,
        `-o -f"${fixture.pom}" -Dtest=example/ExampleTest.java test`,
        `-o -f="${fixture.pom}" -D test=ExampleTest test`,
        `-o --file "${PROJECT}" --define=test=example.ExampleTest test`,
        `-o -f '${fixture.pom}' --define test=ExampleTest test`,
        `-o -f "${fixture.pom}" -Dtest="ExampleTest#focusedMethod" test`,
        `test -Dtest=ExampleTest -f "${fixture.pom}" -o`,
        `-o -f "${fixture.pom}" -Dtest=ExampleTest surefire:test`
    ];
    for (const runner of ['mvn', 'mvn.cmd', 'mvn.bat', 'mvnw', 'mvnw.cmd', 'mvnw.bat', './mvnw', './mvnw.cmd']) {
        for (const form of forms) {
            const command = `${runner} ${form}`;
            const result = validateCommand(command, fixture);
            assert.equal(result.valid, true, `${command}\n${result.violations.join('\n')}`);
        }
    }
});

test('Maven resolves a single test class in the default project', (context) => {
    const fixture = createMavenFixture(context, '');
    for (const command of [
        'mvn -o -Dtest=ExampleTest test',
        'mvn -o -f pom.xml -Dtest=example.ExampleTest test',
        'mvn -o -fpom.xml -Dtest=example/ExampleTest.java test'
    ]) {
        const result = validateCommand(command, fixture);
        assert.equal(result.valid, true, `${command}\n${result.violations.join('\n')}`);
    }
});

test('Maven requires explicit offline mode', (context) => {
    const fixture = createMavenFixture(context);
    assert.equal(validateCommand(`mvn -f "${fixture.pom}" -Dtest=ExampleTest test`, fixture).valid, false);
});

test('Maven preserves attached operand bytes including a second equals sign', (context) => {
    const fixture = createMavenFixture(context);
    for (const command of [
        `mvn -o --file="${fixture.pom}" --define==test=ExampleTest test`,
        `mvn -o --file=="${fixture.pom}" -Dtest=ExampleTest test`,
        `mvn -o -f=="${fixture.pom}" -Dtest=ExampleTest test`
    ]) {
        assert.equal(validateCommand(command, fixture).valid, false, command);
    }
});

test('Maven rejects broad goals, writes, missing operands and non-concrete selectors', (context) => {
    const fixture = createMavenFixture(context);
    const prefix = `mvn -o -f "${fixture.pom}"`;
    for (const command of [
        `${prefix} test`, `${prefix} -Dtest=ExampleTest`,
        `${prefix} -Dtest=ExampleTest clean test`, `${prefix} -Dtest=ExampleTest install`,
        `${prefix} -Dtest=ExampleTest deploy`, `${prefix} -Dtest=ExampleTest package`,
        `${prefix} -Dtest=ExampleTest -fn test`, `${prefix} -Dtest=ExampleTest --fail-never test`,
        `${prefix} -Dtest=ExampleTest -l reports/maven.log test`,
        `${prefix} -Dtest=ExampleTest --log-file=reports/maven.log test`,
        `${prefix} -Dtest=ExampleTest -U test`, `${prefix} -Dtest=ExampleTest -DskipTests test`,
        `${prefix} -Dtest=ExampleTest -Dmaven.test.skip=true test`,
        `${prefix} -Dtest=ExampleTest,OtherTest test`, `${prefix} -Dtest=Example* test`,
        `${prefix} -Dtest="%regex[.*Test]" test`, `${prefix} -Dtest= test`,
        `${prefix} -D test= test`, `${prefix} -Dtest --offline test`,
        `${prefix} -Dtest ExampleTest test`, `${prefix} -D test ExampleTest test`,
        'mvn -f -Dtest=ExampleTest test', 'mvn -f= -Dtest=ExampleTest test',
        'mvn -f --offline -Dtest=ExampleTest test',
        `${prefix} -Dtest=ExampleTest -Dtest=OtherTest test`,
        `${prefix} -Dtest=ExampleTest test "${fixture.target}"`,
        `${prefix} -Dtest=ExampleTest test | node tools/check.js`,
        `${prefix} -Dtest=ExampleTest test && node tools/check.js`,
        `${prefix} -Dtest=ExampleTest test > reports/maven.log`
    ]) {
        const result = validateCommand(command, fixture);
        assert.equal(result.valid, false, command);
    }
});

test('Maven rejects escaped project paths and ambiguous class identity', (context) => {
    const fixture = createMavenFixture(context);
    for (const project of ['../pom.xml', '/tmp/pom.xml', 'C:/outside/pom.xml', '@response-file', 'https://example.com/pom.xml']) {
        const result = validateCommand(`mvn -o -f "${project}" -Dtest=ExampleTest test`, fixture);
        assert.equal(result.valid, false, project);
    }
    const duplicate = `${PROJECT}/src/test/java/other/ExampleTest.java`;
    fs.mkdirSync(path.dirname(path.join(fixture.repoRoot, duplicate)), { recursive: true });
    fs.writeFileSync(path.join(fixture.repoRoot, duplicate), 'package other; public class ExampleTest {}\n');
    const ambiguous = validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest test`, fixture);
    assert.equal(ambiguous.valid, false);
    const exact = validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=example.ExampleTest test`, fixture);
    assert.equal(exact.valid, true, exact.violations.join('\n'));
});

test('Maven project-file operands and unrelated positional files cannot replace the selected Java test', (context) => {
    const fixture = createMavenFixture(context);
    const command = `mvn -o -f "${fixture.pom}" -Dtest=ExampleTest test`;
    const report = focusedReport(command, fixture.pom);
    report.validation_notes[0].command_outcome = 'unavailable';
    report.validation_notes[0].diagnostics = 'Maven fixture executable is unavailable.';
    report.findings.medium.push({
        id: 'F-000',
        title: `[garda:evidence-only:missing-focused-validation] test=${fixture.target}; action=run-and-record-focused-test`,
        description: report.validation_notes[0].diagnostics,
        evidence: report.validation_notes[0].evidence,
        coverage_obligation_ids: ['FILE-001']
    });
    report.coverage_ledger.entries[0].finding_ids.push('F-000');
    const result = validateReviewFindingsReport(report, {
        expectedTaskId: TASK_ID, expectedReviewType: 'code', expectedReviewContextSha256: HASH,
        expectedTreeStateSha256: HASH, expectedChangedFilePaths: [SOURCE],
        expectedCoverageObligationIds: ['FILE-001'], expectedReviewExecutionContract: EXECUTION_CONTRACT,
        repoRoot: fixture.repoRoot
    });
    assert.equal(result.valid, false);
});

test('passed Maven notes preserve the shared contract without repeating the command target', (context) => {
    const fixture = createMavenFixture(context);
    const report = focusedReport(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest test`, fixture.target);
    report.validation_notes[0].evidence[0].observation = 'Reviewed the changed parser boundary and supplied successful diagnostics.';
    const result = validateReviewFindingsReport(report, {
        expectedTaskId: TASK_ID, expectedReviewType: 'code', expectedReviewContextSha256: HASH,
        expectedTreeStateSha256: HASH, expectedChangedFilePaths: [SOURCE],
        expectedCoverageObligationIds: ['FILE-001'], expectedReviewExecutionContract: EXECUTION_CONTRACT,
        repoRoot: fixture.repoRoot
    });
    assert.equal(result.valid, true, result.violations.join('\n'));
});

test('Maven option recognition does not grant the same flags to other runners', (context) => {
    const fixture = createMavenFixture(context);
    for (const command of [
        `node --test -o reports/output "${fixture.target}"`,
        `node -f "${fixture.pom}" --test "${fixture.target}"`,
        `node --test -Dtest=ExampleTest "${fixture.target}"`,
        `pytest -o reports/output "${fixture.target}"`,
        `python -f "${fixture.pom}" "${fixture.target}"`
    ]) {
        const result = validateCommand(command, fixture);
        assert.equal(result.valid, false, command);
    }
});

test('Maven rejects unsupported project layouts, missing Java targets and linked test trees', (context) => {
    const fixture = createMavenFixture(context);
    const command = `mvn -o -f "${fixture.pom}" -Dtest=ExampleTest test`;
    const originalPom = fs.readFileSync(path.join(fixture.repoRoot, fixture.pom), 'utf8');
    for (const configuration of ['<modules><module>child</module></modules>', '<build><testSourceDirectory>custom</testSourceDirectory></build>']) {
        fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom), originalPom.replace('</project>', `${configuration}</project>`));
        assert.equal(validateCommand(command, fixture).valid, false, configuration);
    }
    fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom), originalPom);
    assert.equal(validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=MissingTest test`, fixture).valid, false);
    const javaRoot = path.join(fixture.repoRoot, PROJECT, 'src/test/java');
    const linkedRoot = path.join(javaRoot, 'linked');
    fs.symlinkSync(path.join(javaRoot, 'example'), linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(validateCommand(command, fixture).valid, false);
});

test('Maven rejects linked ancestors of the Java test source root', (context) => {
    for (const ancestor of ['src', 'src/test', 'src/test/java']) {
        const fixture = createMavenFixture(context);
        const linkedPath = path.join(fixture.repoRoot, PROJECT, ancestor);
        const movedPath = path.join(fixture.repoRoot, 'contained-source-tree');
        assert.ok(linkedPath.startsWith(`${fixture.repoRoot}${path.sep}`));
        assert.equal(path.dirname(movedPath), fixture.repoRoot);
        fs.renameSync(linkedPath, movedPath);
        fs.symlinkSync(movedPath, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');
        assert.equal(validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest test`, fixture).valid, false, ancestor);
    }
});

test('Maven rejects parent models with unauthenticated inherited source layouts', (context) => {
    const fixture = createMavenFixture(context);
    const parent = path.join(fixture.repoRoot, 'parent/pom.xml');
    fs.mkdirSync(path.dirname(parent), { recursive: true });
    fs.writeFileSync(parent, '<project><groupId>example</groupId><artifactId>parent</artifactId><version>1</version><build><testSourceDirectory>custom-tests</testSourceDirectory></build></project>');
    fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom), '<project><parent><groupId>example</groupId><artifactId>parent</artifactId><version>1</version><relativePath>../../parent/pom.xml</relativePath></parent><artifactId>child</artifactId></project>');
    assert.equal(validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest test`, fixture).valid, false);
});

test('Maven rejects overridden compiled-test locations instead of binding a default source target', (context) => {
    const fixture = createMavenFixture(context);
    const command = `mvn -o -f "${fixture.pom}" -Dtest=ExampleTest surefire:test`;
    const surefireOverride = '<build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId><configuration><testClassesDirectory>../../compiled-elsewhere</testClassesDirectory></configuration></plugin></plugins></build>';
    fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom), `<project>${surefireOverride}</project>`);
    assert.equal(validateCommand(command, fixture).valid, false);
    for (const layout of [
        '<build><testOutputDirectory>other-test-classes</testOutputDirectory></build>',
        '<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><outputDirectory>other-test-classes</outputDirectory></configuration></plugin></plugins></build>'
    ]) {
        fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom), `<project>${layout}</project>`);
        assert.equal(validateCommand(command, fixture).valid, false, layout);
    }
});

test('Maven rejects build-directory overrides redirecting default compiled output', (context) => {
    const fixture = createMavenFixture(context);
    fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom), '<project><build><directory>../../outside</directory></build></project>');
    assert.equal(validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest test`, fixture).valid, false);
    createParserOnlyCompiledClass(fixture);
    assert.equal(validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest surefire:test`, fixture).valid, false);
    for (const model of [
        '<project><build><resources><resource><directory>src/main/resources</directory></resource></resources><directory>../../outside</directory></build></project>',
        '<project><profiles><profile><build><directory>../../outside</directory></build></profile></profiles></project>',
        '<m:project xmlns:m="http://maven.apache.org/POM/4.0.0"><m:build><m:directory>../../outside</m:directory></m:build></m:project>'
    ]) {
        fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom), model);
        assert.equal(validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest test`, fixture).valid, false, model);
    }
});

test('Maven accepts resource directories that preserve the default test layout', (context) => {
    const fixture = createMavenFixture(context);
    fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom), '<project><build><resources><resource><directory>src/main/resources</directory></resource></resources><testResources><testResource><directory>src/test/resources</directory></testResource></testResources></build></project>');
    assert.equal(validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest test`, fixture).valid, true);
});

test('Maven ignores commented layout declarations instead of rejecting the project', (context) => {
    const fixture = createMavenFixture(context);
    fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom), '<?xml version="1.0"?><!-- example: <directory>outside</directory> --><project><!-- disabled <parent/> and <testOutputDirectory>outside</testOutputDirectory> --></project>');
    assert.equal(validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest test`, fixture).valid, true);
});

test('Maven rejects external links in default compiled-test directories and their ancestors', (context) => {
    const outside = createMavenFixture(context);
    const outsideClass = createParserOnlyCompiledClass(outside);
    const first = createMavenFixture(context);
    fs.symlinkSync(path.dirname(path.dirname(path.dirname(outsideClass))), path.join(first.repoRoot, PROJECT, 'target'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(validateCommand(`mvn -o -f "${first.pom}" -Dtest=ExampleTest surefire:test`, first).valid, false);
    for (const relativeDirectory of ['target/test-classes', 'target/test-classes/example']) {
        const fixture = createMavenFixture(context);
        const linkedPath = path.join(fixture.repoRoot, PROJECT, relativeDirectory);
        fs.mkdirSync(path.dirname(linkedPath), { recursive: true });
        const externalPath = relativeDirectory.endsWith('/example') ? path.dirname(outsideClass) : path.dirname(path.dirname(outsideClass));
        fs.symlinkSync(externalPath, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');
        for (const goal of ['test', 'surefire:test']) {
            assert.equal(validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest ${goal}`, fixture).valid, false, `${relativeDirectory}: ${goal}`);
        }
    }
});

test('Maven rejects linked compiled class files', (context) => {
    const fixture = createMavenFixture(context);
    const outside = createMavenFixture(context);
    const compiledClass = path.join(fixture.repoRoot, PROJECT, 'target/test-classes/example/ExampleTest.class');
    fs.mkdirSync(path.dirname(compiledClass), { recursive: true });
    fs.symlinkSync(createParserOnlyCompiledClass(outside), compiledClass, 'file');
    assert.equal(validateCommand(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest surefire:test`, fixture).valid, false);
});

test('Maven direct Surefire rejects missing or mismatched compiled targets', (context) => {
    const fixture = createMavenFixture(context);
    const command = `mvn -o -f "${fixture.pom}" -Dtest=ExampleTest surefire:test`;
    assert.equal(validateCommand(command, fixture).valid, false);
    const mismatched = createParserOnlyCompiledClass(fixture, 'other/ExampleTest.class');
    assert.equal(validateCommand(command, fixture).valid, false);
    createParserOnlyCompiledClass(fixture);
    assert.equal(validateCommand(command, fixture).valid, false);
    fs.unlinkSync(mismatched);
    assert.equal(validateCommand(command, fixture).valid, true);
});

test('Maven rejects long option aliases masquerading as attached project operands', (context) => {
    const first = createMavenFixture(context, 'ail-never');
    assert.equal(validateCommand('mvn -o -fail-never -Dtest=ExampleTest test', first).valid, false);
    for (const option of ['-fail-at-end', '-fail-fast', '-force-interactive', '-fo', '-force', '-file', '-fi', '-file=pom.xml']) {
        const fixture = createMavenFixture(context, option.slice(2).replace(/^=/u, ''));
        assert.equal(validateCommand(`mvn -o ${option} -Dtest=ExampleTest test`, fixture).valid, false, option);
    }
});

test('Maven failed and unavailable parser fixtures preserve diagnostics and authenticated finding links', (context) => {
    const fixture = createMavenFixture(context);
    for (const outcome of ['failed', 'unavailable']) {
        const report = focusedReport(`mvn -o -f "${fixture.pom}" -Dtest=ExampleTest test`, fixture.target);
        const diagnostics = outcome === 'failed'
            ? 'ExampleTest fixture assertion expected 2 but received 1; Tests run: 1, Failures: 1.'
            : 'Maven fixture executable is absent from PATH; the ExampleTest attempt could not start.';
        const findingId = outcome === 'failed' ? 'F-001' : 'F-000';
        report.validation_notes[0].command_outcome = outcome;
        report.validation_notes[0].diagnostics = diagnostics;
        report.findings.medium.push({
            id: findingId,
            title: outcome === 'failed' ? 'ExampleTest fixture assertion failed'
                : `[garda:evidence-only:missing-focused-validation] test=${fixture.target}; action=run-and-record-focused-test`,
            description: diagnostics, evidence: report.validation_notes[0].evidence,
            coverage_obligation_ids: ['FILE-001']
        });
        if (outcome === 'failed') report.validation_notes[0].finding_ids.push(findingId);
        report.coverage_ledger.entries[0].finding_ids.push(findingId);
        const result = validateReviewFindingsReport(report, {
            expectedTaskId: TASK_ID, expectedReviewType: 'code', expectedReviewContextSha256: HASH,
            expectedTreeStateSha256: HASH, expectedChangedFilePaths: [SOURCE],
            expectedCoverageObligationIds: ['FILE-001'], expectedReviewExecutionContract: EXECUTION_CONTRACT,
            repoRoot: fixture.repoRoot
        });
        assert.equal(result.valid, true, `${outcome}\n${result.violations.join('\n')}`);
        assert.equal(result.report?.validation_notes[0].command_outcome, outcome);
        assert.equal(result.report?.validation_notes[0].diagnostics, diagnostics);
    }
});

async function assertNativeMavenIngestion(fixture: ReturnType<typeof createMavenFixture>, diagnostics: string, parserOnly: boolean) {
    const taskId = 'T-177-native-maven';
    const native = await seedPromptBoundReviewFixture({ repoRoot: fixture.repoRoot, taskId });
    attestReviewerInvocationForTest({
        repoRoot: fixture.repoRoot, taskId, reviewType: 'code', reviewContextPath: native.reviewContextPath,
        reviewerIdentity: native.reviewerIdentity
    });
    const command = `${process.platform === 'win32' ? 'mvn.cmd' : 'mvn'} -o -f "${fixture.pom}" -Dtest=ExampleTest test`;
    const report = buildNoFindingsJsonReviewReport(native.reviewContextPath, taskId);
    report.validation_notes = [{
        id: 'N-001', topic: 'focused-self-validation',
        note: parserOnly ? 'Parser-only ingestion fixture; this report does not claim a Maven execution.'
            : 'The local Maven executable ran ExampleTest; the unselected failing test was not executed.',
        command: `${command} --log-file=reports/output.log`, command_outcome: 'passed', diagnostics,
        evidence: [{ location: 'src/app.ts:1', observation: 'The changed app parser boundary and successful diagnostics were reviewed.' }]
    }];
    const outputPath = path.join(fixture.repoRoot, 'garda-agent-orchestrator/runtime/tmp/reviews', taskId, 'code/review-output.md');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const arguments_ = [
        'gate', 'record-review-result', '--task-id', taskId, '--review-type', 'code',
        '--preflight-path', native.preflightPath, '--review-output-path', outputPath,
        '--repo-root', fixture.repoRoot, '--reviewer-execution-mode', 'delegated_subagent',
        '--reviewer-identity', native.reviewerIdentity
    ];
    const rejectedText = JSON.stringify(report);
    fs.writeFileSync(outputPath, rejectedText);
    const rejected = await runCliWithCapturedOutput(arguments_, { cwd: fixture.repoRoot });
    assert.notEqual(rejected.exitCode, 0);
    assert.match(rejected.errors.join('\n'), /unsupported or incomplete Maven/u);
    assert.equal(fs.existsSync(path.join(native.reviewsRoot, `${taskId}-code-receipt.json`)), false);
    assert.equal(fs.readFileSync(outputPath, 'utf8'), rejectedText);
    (report.validation_notes as Array<Record<string, unknown>>)[0].command = command;
    fs.writeFileSync(outputPath, JSON.stringify(report));
    const accepted = await runCliWithCapturedOutput(arguments_, { cwd: fixture.repoRoot });
    assert.equal(accepted.exitCode, 0, accepted.errors.join('\n'));
    const canonical = JSON.parse(fs.readFileSync(path.join(native.reviewsRoot, `${taskId}-code-review-output.md`), 'utf8'));
    assert.equal(canonical.validation_notes[0].command, command);
    assert.equal(canonical.validation_notes[0].diagnostics, diagnostics);
    assert.equal(canonical.validation_notes[0].command_outcome, 'passed');
}

test('native ingestion rejects Maven output flags and preserves corrected parser-only evidence', async (context) => {
    await assertNativeMavenIngestion(createMavenFixture(context, PROJECT, true), 'Parser fixture: ExampleTest selector maps to 1 Java file.', true);
});

function findLocalMavenExecutable(): string | undefined {
    const executable = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
    return (process.env.PATH || '').split(path.delimiter).map((directory) => path.join(directory, executable))
        .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

test('available local Maven executes one Java test offline and its actual output survives native ingestion', async (context) => {
    const executable = findLocalMavenExecutable();
    if (!executable) {
        context.skip('Local Maven executable is unavailable; parser-only checks do not establish Maven execution.');
        return;
    }
    const fixture = createMavenFixture(context, PROJECT, true);
    fs.writeFileSync(path.join(fixture.repoRoot, fixture.pom), `<project>
<modelVersion>4.0.0</modelVersion><groupId>garda.fixture</groupId><artifactId>focused-validation</artifactId><version>1</version>
<properties><maven.compiler.release>17</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
<dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10.5</version><scope>test</scope></dependency></dependencies>
<build><plugins>
<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId><version>3.3.1</version></plugin>
<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version></plugin>
<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version></plugin>
</plugins></build></project>\n`);
    fs.writeFileSync(path.join(fixture.repoRoot, fixture.target), 'package example; public class ExampleTest { @org.junit.jupiter.api.Test public void focusedMethod() { org.junit.jupiter.api.Assertions.assertEquals(2, 1 + 1); } }\n');
    fs.writeFileSync(path.join(fixture.repoRoot, PROJECT, 'src/test/java/example/UnselectedTest.java'), 'package example; public class UnselectedTest { @org.junit.jupiter.api.Test public void mustNotRun() { org.junit.jupiter.api.Assertions.fail("Unselected test ran"); } }\n');
    const commandArguments = ['-o', '-f', fixture.pom, '-Dtest=ExampleTest', 'test'];
    const execution = process.platform === 'win32'
        ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${executable}" -o -f "${fixture.pom}" -Dtest=ExampleTest test"`], {
            cwd: fixture.repoRoot, encoding: 'utf8', timeout: 60000, windowsVerbatimArguments: true, windowsHide: true
        })
        : spawnSync(executable, commandArguments, { cwd: fixture.repoRoot, encoding: 'utf8', timeout: 60000 });
    const diagnostics = `${execution.stdout || ''}${execution.stderr || ''}`;
    assert.equal(execution.status, 0, `${execution.error || ''}\n${diagnostics}`);
    assert.match(diagnostics, /Tests run: 1, Failures: 0, Errors: 0/u);
    assert.doesNotMatch(diagnostics, /Running example\.UnselectedTest/u);
    context.diagnostic(`Actual offline Maven execution: ${executable}; Tests run: 1, Failures: 0, Errors: 0.`);
    await assertNativeMavenIngestion(fixture, diagnostics, false);
});
