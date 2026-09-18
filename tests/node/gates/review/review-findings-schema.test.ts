import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
    REVIEW_FINDINGS_SCHEMA_VERSION,
    reviewFindingsReportJsonSchema,
    validateReviewFindingsReport
} from '../../../../src/gates/review/review-findings-schema';
import {
    buildReviewCoverageContract
} from '../../../../src/gates/review/review-coverage-ledger';
import {
    buildReviewRemediationReviewContract,
    type ReviewRemediationReviewContract
} from '../../../../src/gates/review-remediation/review-remediation-review-contract';
import { buildReviewerFindingsOutputTemplateJson } from '../../../../src/gates/review/reviewer-findings-prompt-contract';
import {
    validateReviewFindingsContract
} from '../../../../src/gates/review/review-findings-artifact-verdict';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CONTRACT_HASH = 'c'.repeat(64);

const INITIAL_REVIEW_EXECUTION_CONTRACT = buildReviewRemediationReviewContract({
    taskId: 'T-979-1',
    reviewType: 'code',
    preflightSha256: CONTRACT_HASH,
    fullReviewScope: ['src/example.ts']
});

function evidence(location = 'src/example.ts:10', observation = 'Concrete parser branch was checked against malformed input'): object {
    return { location, observation };
}

function validReport(): Record<string, unknown> {
    return {
        schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
        task_id: 'T-979-1',
        review_type: 'code',
        review_context_sha256: HASH_A,
        tree_state_sha256: HASH_B,
        validation_notes: [{
            id: 'N-001',
            topic: 'schema-shape',
            note: 'The reviewer inspected all required schema fields and coverage obligations.',
            evidence: [evidence()]
        }],
        coverage_ledger: {
            coverage_contract_sha256: CONTRACT_HASH,
            entries: [
                {
                    obligation_id: 'FILE-001',
                    evidence: [evidence()],
                    finding_ids: []
                },
                {
                    obligation_id: 'CATEGORY-SCHEMA',
                    evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                    finding_ids: []
                }
            ]
        },
        review_execution: {
            mode: 'FULL',
            contract_sha256: INITIAL_REVIEW_EXECUTION_CONTRACT.contract_sha256,
            covered_delta_targets: [],
            inspected_prior_finding_ids: []
        },
        findings: {
            critical: [],
            high: [],
            medium: [],
            low: []
        },
        residual_risks: [],
        reviewer_notes: ['No reviewer-owned remediation or verdict was supplied.']
    };
}

function missingFocusedValidationReport(): Record<string, unknown> {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'Prior focused execution for tests/node/example.test.ts was absent, so the reviewer attempted that smallest local check.',
        command: 'node --test tests/node/example.test.ts',
        command_outcome: 'unavailable',
        diagnostics: 'The test runtime is not installed in the isolated reviewer environment.',
        evidence: [evidence(
            'src/example.ts:10',
            'The changed parser branch is covered by tests/node/example.test.ts, which motivated the focused attempt.'
        )]
    }];
    report.findings = {
        critical: [],
        high: [],
        medium: [{
            id: 'F-000',
            title: '[garda:evidence-only:missing-focused-validation] test=tests/node/example.test.ts; action=run-and-record-focused-test',
            description: 'The focused command could not execute because the isolated environment lacks the test runtime.',
            evidence: [evidence()],
            coverage_obligation_ids: ['FILE-001']
        }],
        low: []
    };
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [evidence()],
                finding_ids: ['F-000']
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                finding_ids: []
            }
        ]
    };
    return report;
}

const validationOptions = {
    expectedTaskId: 'T-979-1',
    expectedReviewType: 'code',
    expectedCoverageObligationIds: ['FILE-001', 'CATEGORY-SCHEMA'],
    expectedChangedFilePaths: ['src/example.ts'],
    expectedReviewContextSha256: HASH_A,
    expectedTreeStateSha256: HASH_B,
    expectedReviewExecutionContract: INITIAL_REVIEW_EXECUTION_CONTRACT
};

type JsonObject = Record<string, unknown>;

function cloneReport(report: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
}

function isJsonObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveSchemaRef(root: JsonObject, ref: string): JsonObject {
    const parts = ref.replace(/^#\//u, '').split('/');
    let current: unknown = root;
    for (const part of parts) {
        assert.ok(isJsonObject(current), `schema ref ${ref} resolved through a non-object segment`);
        current = current[part];
    }
    assert.ok(isJsonObject(current), `schema ref ${ref} did not resolve to an object`);
    return current;
}

function schemaViolations(value: unknown, schema: JsonObject, root = schema, path = '$'): string[] {
    const ref = typeof schema.$ref === 'string' ? schema.$ref : null;
    if (ref) {
        return schemaViolations(value, resolveSchemaRef(root, ref), root, path);
    }

    const violations: string[] = [];
    if ('const' in schema && value !== schema.const) {
        violations.push(`${path} must equal schema const`);
    }

    if (schema.type === 'object') {
        if (!isJsonObject(value)) {
            return [`${path} must be an object`];
        }
        const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
        required
            .filter((key) => !(key in value))
            .forEach((key) => violations.push(`${path}.${key} is required`));
        const properties = isJsonObject(schema.properties) ? schema.properties : {};
        if (schema.additionalProperties === false) {
            Object.keys(value)
                .filter((key) => !(key in properties))
                .forEach((key) => violations.push(`${path}.${key} is not allowed`));
        }
        for (const [key, propertySchema] of Object.entries(properties)) {
            if (key in value) {
                assert.ok(isJsonObject(propertySchema), `${path}.${key} schema must be an object`);
                violations.push(...schemaViolations(value[key], propertySchema, root, `${path}.${key}`));
            }
        }
    } else if (schema.type === 'array') {
        if (!Array.isArray(value)) {
            return [`${path} must be an array`];
        }
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
            violations.push(`${path} must contain at least ${schema.minItems} item(s)`);
        }
        if (isJsonObject(schema.items)) {
            value.forEach((entry, index) => {
                violations.push(...schemaViolations(entry, schema.items as JsonObject, root, `${path}[${index}]`));
            });
        }
    } else if (schema.type === 'string') {
        if (typeof value !== 'string') {
            return [`${path} must be a string`];
        }
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
            violations.push(`${path} must have length at least ${schema.minLength}`);
        }
        if (typeof schema.pattern === 'string' && !(new RegExp(schema.pattern, 'u')).test(value)) {
            violations.push(`${path} must match ${schema.pattern}`);
        }
    }

    return violations;
}

function jsonSchemaViolations(report: Record<string, unknown>): string[] {
    return schemaViolations(report, reviewFindingsReportJsonSchema as JsonObject);
}

test('review findings schema exposes a strict versioned JSON object contract', () => {
    assert.equal(reviewFindingsReportJsonSchema.$id, 'garda-agent-orchestrator/review-findings-report.schema.json');
    assert.equal(reviewFindingsReportJsonSchema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(reviewFindingsReportJsonSchema.additionalProperties, false);
    assert.equal(reviewFindingsReportJsonSchema.properties.schema_version.const, REVIEW_FINDINGS_SCHEMA_VERSION);
    assert.ok(reviewFindingsReportJsonSchema.required.includes('coverage_ledger'));
    assert.ok(reviewFindingsReportJsonSchema.required.includes('review_execution'));
    assert.ok(reviewFindingsReportJsonSchema.required.includes('findings'));
});

test('published review findings schema stays synchronized with the runtime contract', () => {
    const publishedSchema = JSON.parse(fs.readFileSync(
        path.join(process.cwd(), 'template', 'schemas', 'review-findings-report.schema.json'),
        'utf8'
    ));

    assert.deepEqual(publishedSchema, reviewFindingsReportJsonSchema);
});

test('review findings JSON schema models nested sections for machine validation', () => {
    const report = validReport();

    assert.deepEqual(jsonSchemaViolations(report), []);

    const malformed = cloneReport(report);
    const validationNote = (malformed.validation_notes as Array<Record<string, unknown>>)[0];
    delete (validationNote.evidence as Array<Record<string, unknown>>)[0].observation;
    ((malformed.coverage_ledger as Record<string, unknown>).entries as Array<Record<string, unknown>>)[0].unexpected = true;
    (malformed.findings as Record<string, unknown>).medium = [{
        id: 'M-001',
        title: 'Malformed finding id',
        description: 'The exported JSON schema must reject this nested finding shape.',
        evidence: [],
        coverage_obligation_ids: []
    }];
    malformed.residual_risks = [{
        id: 'RISK-001',
        description: 'Malformed residual risk id.',
        evidence: [evidence()]
    }];

    const violations = jsonSchemaViolations(malformed);

    assert.ok(violations.some((entry) => entry.includes('$.validation_notes[0].evidence[0].observation is required')));
    assert.ok(violations.some((entry) => entry.includes('$.coverage_ledger.entries[0].unexpected is not allowed')));
    assert.ok(violations.some((entry) => entry.includes('$.findings.medium[0].id must match')));
    assert.ok(violations.some((entry) => entry.includes('$.findings.medium[0].evidence must contain at least 1 item')));
    assert.ok(violations.some((entry) => entry.includes('$.findings.medium[0].coverage_obligation_ids must contain at least 1 item')));
    assert.ok(violations.some((entry) => entry.includes('$.residual_risks[0].id must match')));
});

test('validateReviewFindingsReport accepts empty findings only with complete coverage evidence', () => {
    const result = validateReviewFindingsReport(validReport(), validationOptions);

    assert.equal(result.valid, true);
    assert.equal(result.report?.task_id, 'T-979-1');
    assert.deepEqual(result.report?.review_execution, {
        mode: 'FULL',
        contract_sha256: INITIAL_REVIEW_EXECUTION_CONTRACT.contract_sha256,
        covered_delta_targets: [],
        inspected_prior_finding_ids: []
    });
    assert.equal(result.review_execution_authentication, 'authenticated');
    assert.deepEqual(result.report?.findings.high, []);
    assert.deepEqual(result.violations, []);
});

test('validateReviewFindingsReport authenticates complete DELTA execution coverage', () => {
    const coverageContract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: ['src/example.ts'] });
    const reviewExecutionContract: ReviewRemediationReviewContract = {
        ...INITIAL_REVIEW_EXECUTION_CONTRACT,
        mode: 'DELTA',
        source: 'remediation_delta',
        contract_sha256: 'd'.repeat(64),
        delta: {
            origin_review_type: 'code', classification_sha256: HASH_A, current_snapshot_sha256: HASH_B,
            required_delta_targets: ['src/example.ts'], required_delta_targets_sha256: HASH_A,
            context_files: [], context_files_sha256: HASH_B
        },
        finding_reconciliation: {
            ...INITIAL_REVIEW_EXECUTION_CONTRACT.finding_reconciliation,
            resolvable_finding_ids: ['F-001'],
            resolvable_finding_ids_sha256: HASH_A
        }
    };
    const template = JSON.parse(buildReviewerFindingsOutputTemplateJson({
        taskId: 'T-979-1', reviewType: 'code', reviewContextSha256: HASH_A,
        treeStateSha256: HASH_B, coverageContract, reviewExecutionContract
    }));
    const report = validReport();
    report.review_execution = template.review_execution;
    const result = validateReviewFindingsReport(report, {
        ...validationOptions,
        expectedReviewExecutionContract: reviewExecutionContract
    });
    assert.equal(result.valid, true, result.violations.join('\n'));
    assert.equal(result.review_execution_authentication, 'authenticated');
    assert.deepEqual(result.report?.review_execution, {
        mode: 'DELTA', contract_sha256: 'd'.repeat(64),
        covered_delta_targets: ['src/example.ts'], inspected_prior_finding_ids: ['F-001']
    });
});
test('validateReviewFindingsReport rejects missing authenticated execution contract before exposing execution claims', () => {
    const structuralOnly = validateReviewFindingsReport(validReport(), {
        ...validationOptions,
        expectedReviewExecutionContract: undefined
    });

    assert.equal(structuralOnly.valid, false);
    assert.equal(structuralOnly.report, null);
    assert.equal(structuralOnly.review_execution_authentication, 'structural_only');
    assert.ok(structuralOnly.violations.includes(
        'expectedReviewExecutionContract is required to authenticate review_execution evidence.'
    ));

    const diagnosticOnly = validateReviewFindingsReport(validReport(), {
        ...validationOptions,
        expectedReviewExecutionContract: undefined,
        allowStructuralOnlyReviewExecution: true
    });

    assert.equal(diagnosticOnly.valid, true, diagnosticOnly.violations.join('\n'));
    assert.equal(diagnosticOnly.review_execution_authentication, 'structural_only');
    assert.ok(diagnosticOnly.report);

    const authenticated = validateReviewFindingsReport(validReport(), {
        ...validationOptions,
        expectedReviewExecutionContract: INITIAL_REVIEW_EXECUTION_CONTRACT
    });

    assert.equal(authenticated.valid, true, authenticated.violations.join('\n'));
    assert.equal(authenticated.review_execution_authentication, 'authenticated');
    assert.deepEqual(authenticated.report?.review_execution, {
        mode: 'FULL',
        contract_sha256: INITIAL_REVIEW_EXECUTION_CONTRACT.contract_sha256,
        covered_delta_targets: [],
        inspected_prior_finding_ids: []
    });

    const forged = validReport();
    (forged.review_execution as Record<string, unknown>).contract_sha256 = 'f'.repeat(64);
    const rejected = validateReviewFindingsReport(forged, {
        ...validationOptions,
        expectedReviewExecutionContract: INITIAL_REVIEW_EXECUTION_CONTRACT
    });

    assert.equal(rejected.valid, false);
    assert.equal(rejected.report, null);
    assert.ok(rejected.violations.some((entry) => entry.includes(
        'review_execution evidence contract_sha256 does not match the launch contract'
    )));
});

test('validateReviewFindingsReport rejects a missing review execution declaration', () => {
    const report = validReport();
    delete report.review_execution;

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.equal(result.report, null);
    assert.ok(result.violations.includes('review_execution is required.'));
});

test('validateReviewFindingsReport accepts F-000 only with post-attempt focused command evidence', () => {
    const result = validateReviewFindingsReport(missingFocusedValidationReport(), validationOptions);

    assert.equal(result.valid, true, result.violations.join('\n'));
    assert.equal(result.report?.validation_notes[0]?.command, 'node --test tests/node/example.test.ts');
    assert.equal(result.report?.validation_notes[0]?.command_outcome, 'unavailable');
});

test('validateReviewFindingsReport accepts a non-test focused validation target', () => {
    const report = missingFocusedValidationReport();
    const finding = (report.findings as Record<string, Array<Record<string, unknown>>>).medium[0];
    finding.title = '[garda:evidence-only:missing-focused-validation] target=api/openapi.yaml; action=run-and-record-focused-validation';
    const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
    note.note = 'Prior focused validation for api/openapi.yaml was absent, so the reviewer attempted that smallest local check.';
    note.command = 'node tools/validate-contract.js api/openapi.yaml';
    note.evidence = [evidence(
        'src/example.ts:10',
        'The changed contract parser consumes api/openapi.yaml, which motivated the focused validation.'
    )];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, true, result.violations.join('\n'));
});

test('validateReviewFindingsReport accepts known extensionless focused validation targets', () => {
    for (const target of ['Dockerfile', 'build/Makefile']) {
        const report = missingFocusedValidationReport();
        const finding = (report.findings as Record<string, Array<Record<string, unknown>>>).medium[0];
        finding.title = `[garda:evidence-only:missing-focused-validation] target=${target}; action=run-and-record-focused-validation`;
        const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
        note.note = `Prior focused validation for ${target} was absent, so the reviewer attempted that smallest local check.`;
        note.command = `node tools/validate-dockerfile.js ${target}`;
        note.evidence = [evidence(
            'src/example.ts:10',
            `The changed configuration parser consumes ${target}, which motivated the focused validation.`
        )];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, true, `${target}\n${result.violations.join('\n')}`);
    }
});

test('validateReviewFindingsReport accepts existing custom extensionless and spaced focused targets', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-focused-targets-'));
    try {
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.config'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'example.ts'),
            Array.from({ length: 25 }, (_, index) => `// line ${index + 1}`).join('\n') + '\n',
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, 'CODEOWNERS'), '* @reviewers\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.config', 'review rules'), 'strict\n', 'utf8');

        for (const { target, command } of [
            { target: 'CODEOWNERS', command: 'npm run validate:compliance -- CODEOWNERS' },
            { target: '.config/review rules', command: 'node tools/validate-contract.js ".config/review rules"' }
        ]) {
            const report = missingFocusedValidationReport();
            const finding = (report.findings as Record<string, Array<Record<string, unknown>>>).medium[0];
            finding.title = `[garda:evidence-only:missing-focused-validation] target=${target}; action=run-and-record-focused-validation`;
            const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
            note.note = `The reviewer attempted the smallest custom validation for ${target}.`;
            note.command = command;
            note.evidence = [evidence(
                'src/example.ts:10',
                `The changed ownership parser consumes ${target}, which motivated the focused validation.`
            )];

            const result = validateReviewFindingsReport(report, { ...validationOptions, repoRoot });

            assert.equal(result.valid, true, `${target}\n${result.violations.join('\n')}`);
        }
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateReviewFindingsReport accepts equivalent focused target path spellings', () => {
    const prefixedCommand = missingFocusedValidationReport();
    (prefixedCommand.validation_notes as Array<Record<string, unknown>>)[0].command =
        'node --test ./tests\\node\\example.test.ts';
    const prefixedResult = validateReviewFindingsReport(prefixedCommand, validationOptions);
    assert.equal(prefixedResult.valid, true, prefixedResult.violations.join('\n'));

    const backslashMarker = missingFocusedValidationReport();
    const finding = (backslashMarker.findings as Record<string, Array<Record<string, unknown>>>).medium[0];
    finding.title = '[garda:evidence-only:missing-focused-validation] target=tests\\node\\example.test.ts; action=run-and-record-focused-validation';
    const backslashResult = validateReviewFindingsReport(backslashMarker, validationOptions);
    assert.equal(backslashResult.valid, true, backslashResult.violations.join('\n'));
});

test('validateReviewFindingsReport keeps focused target matching case-sensitive', () => {
    const report = missingFocusedValidationReport();
    const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
    note.command = 'node --test tests/node/Example.test.ts';
    note.evidence = [evidence(
        'src/example.ts:10',
        'The changed parser branch is covered by tests/node/Example.test.ts.'
    )];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("target 'tests/node/example.test.ts'")));
});

test('validateReviewFindingsReport keeps the canonical F-000 marker case-sensitive', () => {
    const report = missingFocusedValidationReport();
    const finding = (report.findings as Record<string, Array<Record<string, unknown>>>).medium[0];
    finding.title = '[GARDA:evidence-only:missing-focused-validation] target=tests/node/example.test.ts; action=run-and-record-focused-validation';

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('exact canonical missing-focused-validation marker')));
});

test('validateReviewFindingsReport rejects focused commands with unrelated additional targets', () => {
    for (const command of [
        'node --test tests/node/example.test.ts tests/node/other.test.ts',
        'node tools/validate-contract.js api/openapi.yaml api/other.yaml',
        'node --test tests/node/example.test.ts tests/node/*.test.ts',
        'node --test tests/node/example.test.ts not-a-target',
        'node --test tests/node/example.test.ts tests/../outside.test.ts',
        'node --test tests/node/example.test.ts C:outside.test.ts'
    ]) {
        const report = validReport();
        report.validation_notes = [{
            id: 'N-001',
            topic: 'focused-self-validation',
            note: 'The reviewer claimed to run one exact focused target.',
            command,
            command_outcome: 'passed',
            diagnostics: 'The command returned zero for multiple repository targets.',
            evidence: [evidence()]
        }];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, command);
        assert.ok(
            result.violations.some((entry) => entry.includes('must execute a focused test or validation command')),
            command
        );
    }
});

test('validateReviewFindingsReport accepts one focused target with selector option values', () => {
    for (const command of [
        'pytest -k parser tests/example_test.py',
        'node --test --test-name-pattern parser tests/node/example.test.ts'
    ]) {
        const report = validReport();
        report.validation_notes = [{
            id: 'N-001',
            topic: 'focused-self-validation',
            note: 'The reviewer ran one exact focused target with a selector.',
            command,
            command_outcome: 'passed',
            diagnostics: 'The focused parser selection completed with twelve passing assertions.',
            evidence: [evidence(
                'src/example.ts:10',
                `The changed parser branch is covered by ${command.startsWith('pytest')
                    ? 'tests/example_test.py'
                    : 'tests/node/example.test.ts'}.`
            )]
        }];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, true, `${command}\n${result.violations.join('\n')}`);
    }
});

test('validateReviewFindingsReport accepts direct validation runner subcommands', () => {
    for (const { command, target } of [
        { command: 'spectral lint api/openapi.yaml', target: 'api/openapi.yaml' },
        { command: 'ajv validate api/schema.json', target: 'api/schema.json' },
        { command: 'vitest run tests/node/example.test.ts', target: 'tests/node/example.test.ts' },
        { command: 'playwright test tests/e2e/example.spec.ts', target: 'tests/e2e/example.spec.ts' },
        { command: 'cypress run tests/e2e/example.spec.ts', target: 'tests/e2e/example.spec.ts' }
    ]) {
        const report = validReport();
        report.validation_notes = [{
            id: 'N-001',
            topic: 'focused-self-validation',
            note: 'The reviewer ran one direct validation runner subcommand.',
            command,
            command_outcome: 'passed',
            diagnostics: 'The focused runner completed twelve checks successfully.',
            evidence: [evidence(
                'src/example.ts:10',
                `The changed parser consumes ${target}, which motivated the focused validation.`
            )]
        }];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, true, `${command}\n${result.violations.join('\n')}`);
    }
});

test('validateReviewFindingsReport rejects nonexistent and directory targets when repo context is available', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-focused-invalid-targets-'));
    try {
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests', 'directory.test.ts'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'example.ts'),
            Array.from({ length: 25 }, (_, index) => `// line ${index + 1}`).join('\n') + '\n',
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, 'tests', 'real.test.ts'), '// test\n', 'utf8');

        for (const target of [
            'tests/missing.test.ts',
            'tests/directory.test.ts',
            'tests/real.test.ts::case'
        ]) {
            const report = validReport();
            report.validation_notes = [{
                id: 'N-001',
                topic: 'focused-self-validation',
                note: 'The reviewer claimed a real focused target.',
                command: `node --test ${target}`,
                command_outcome: 'passed',
                diagnostics: 'The focused runner reported one passing test.',
                evidence: [evidence(
                    'src/example.ts:10',
                    `The changed parser was claimed to be covered by ${target}.`
                )]
            }];

            const result = validateReviewFindingsReport(report, { ...validationOptions, repoRoot });

            assert.equal(result.valid, false, target);
            assert.ok(result.violations.some((entry) => entry.includes(
                'must execute a focused test or validation command'
            )), target);
        }
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateReviewFindingsReport accepts safe no-emit TypeScript validation', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The reviewer type-checked one changed TypeScript target.',
        command: 'tsc --noEmit --pretty false src/example.ts',
        command_outcome: 'passed',
        diagnostics: '12 checks passed',
        evidence: [evidence(
            'src/example.ts:10',
            'The changed declaration in src/example.ts motivated the no-emit type check.'
        )]
    }];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, true, result.violations.join('\n'));
});

test('validateReviewFindingsReport accepts Node syntax checks without executing the target', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-node-check-'));
    try {
        fs.mkdirSync(path.join(repoRoot, 'src'));
        fs.writeFileSync(path.join(repoRoot, 'src', 'example.ts'),
            Array.from({ length: 25 }, (_, index) => `// line ${index + 1}`).join('\n') + '\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'example.js'),
            "require('node:fs').writeFileSync('executed.txt', 'unexpected');\n", 'utf8');
        execFileSync(process.execPath, ['--check', 'src/example.js'], { cwd: repoRoot });
        assert.equal(fs.existsSync(path.join(repoRoot, 'executed.txt')), false);

        for (const command of [
            'node --check src/example.js',
            'node --no-warnings --check src/example.js',
            'node.exe --check src/example.js'
        ]) {
            const report = validReport();
            report.validation_notes = [{
                id: 'N-001', topic: 'focused-self-validation',
                note: 'The reviewer checked the changed JavaScript syntax without executing it.',
                command, command_outcome: 'passed', diagnostics: 'JavaScript syntax check completed without parse errors.',
                evidence: [evidence('src/example.ts:10', 'The changed entrypoint consumes src/example.js, which motivated the syntax check.')]
            }];
            const result = validateReviewFindingsReport(report, { ...validationOptions, repoRoot });
            assert.equal(result.valid, true, `${command}\n${result.violations.join('\n')}`);
        }
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateReviewFindingsReport rejects F-000 when the command only prints the marker target', () => {
    for (const command of ['echo tests/node/example.test.ts', 'echo --test tests/node/example.test.ts']) {
        const report = missingFocusedValidationReport();
        const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
        note.command = command;

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, command);
        assert.ok(
            result.violations.some((entry) => entry.includes("execute target 'tests/node/example.test.ts' through a focused test or validation runner")),
            command
        );
    }
});

test('validateReviewFindingsReport rejects passed focused notes without a validation execution', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The reviewer claimed to run the focused target.',
        command: 'echo --test tests/node/example.test.ts',
        command_outcome: 'passed',
        diagnostics: 'The command returned zero without executing the test.',
        evidence: [evidence()]
    }];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('must execute a focused test or validation command')));
});

test('validateReviewFindingsReport rejects non-validation runners with validation-looking targets', () => {
    for (const command of [
        'test -f tests/node/example.test.ts',
        'node scripts/print-file.js tests/node/example.test.ts'
    ]) {
        const report = validReport();
        report.validation_notes = [{
            id: 'N-001',
            topic: 'focused-self-validation',
            note: 'The reviewer claimed that inspecting the target executed its validation.',
            command,
            command_outcome: 'passed',
            diagnostics: 'No focused test or validation runner executed the target.',
            evidence: [evidence()]
        }];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, command);
        assert.ok(
            result.violations.some((entry) => entry.includes('must execute a focused test or validation command')),
            command
        );
    }
});

test('validateReviewFindingsReport rejects focused notes without a concrete file target', () => {
    for (const command of [
        'npm --silent test',
        'npm test -- --runInBand',
        'node --test',
        'node tools/validate-contract.js',
        'node --test tests/node'
    ]) {
        const report = validReport();
        report.validation_notes = [{
            id: 'N-001',
            topic: 'focused-self-validation',
            note: 'The reviewer claimed to run a focused target.',
            command,
            command_outcome: 'passed',
            diagnostics: 'The command returned zero without naming a concrete target.',
            evidence: [evidence()]
        }];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, command);
        assert.ok(
            result.violations.some((entry) => (
                entry.includes('broad build, full suite')
                || entry.includes('must execute a focused test or validation command')
            )),
            command
        );
    }
});

test('validateReviewFindingsReport rejects command evidence hidden under another topic', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'schema-shape',
        note: 'The reviewer attached failed command metadata to an unrelated topic.',
        command: 'echo --test tests/node/example.test.ts',
        command_outcome: 'failed',
        diagnostics: 'The command did not execute the named test.',
        finding_ids: ['F-999'],
        evidence: [evidence()]
    }];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("topic must be 'focused-self-validation'")));
    assert.ok(result.violations.some((entry) => entry.includes('must execute a focused test or validation command')));
    assert.ok(result.violations.some((entry) => entry.includes("references unknown ordinary finding id 'F-999'")));
});

test('validateReviewFindingsReport rejects F-000 without a real focused attempt record', () => {
    const report = missingFocusedValidationReport();
    report.validation_notes = validReport().validation_notes;

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('requires a focused-self-validation validation note')));
});

test('validateReviewFindingsReport rejects focused-self-validation notes without complete command evidence', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The reviewer considered a narrow focused check.',
        evidence: [evidence()]
    }];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('.command is required')));
    assert.ok(result.violations.some((entry) => entry.includes('.command_outcome must be')));
    assert.ok(result.violations.some((entry) => entry.includes('.diagnostics is required')));
});

test('validateReviewFindingsReport rejects standalone finding_ids on ordinary validation notes', () => {
    const report = validReport();
    (report.validation_notes as Array<Record<string, unknown>>)[0].finding_ids = ['F-001'];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("topic must be 'focused-self-validation'")));
    assert.ok(result.violations.some((entry) => entry.includes('.command is required')));
    assert.ok(result.violations.some((entry) => entry.includes('.command_outcome must be')));
    assert.ok(result.violations.some((entry) => entry.includes('.diagnostics is required')));
});

test('validateReviewFindingsReport rejects placeholder focused-command diagnostics', () => {
    for (const diagnostics of [
        'n/a',
        'unknown',
        '-',
        'The command failed.',
        'The command was unavailable.',
        'The focused target was prohibited.',
        'The command could not run.'
    ]) {
        const report = missingFocusedValidationReport();
        (report.validation_notes as Array<Record<string, unknown>>)[0].diagnostics = diagnostics;

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, diagnostics);
        assert.ok(
            result.violations.some((entry) => entry.includes('concrete, actionable command result detail rather than a placeholder')),
            diagnostics
        );
    }
});

test('validateReviewFindingsReport rejects noncanonical F-000 findings even with attempt evidence', () => {
    const report = missingFocusedValidationReport();
    const finding = (report.findings as Record<string, Array<Record<string, unknown>>>).medium[0];
    finding.title = 'Focused validation was unavailable';

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('F-000 is reserved for the exact canonical')));
});

test('validateReviewFindingsReport rejects missing-focused-execution claims in ordinary findings and residual risks', () => {
    const ordinaryFindingReport = validReport();
    (ordinaryFindingReport.findings as Record<string, Array<Record<string, unknown>>>).high = [{
        id: 'F-001',
        title: 'Focused validation was unavailable',
        description: 'No prior focused execution evidence exists for the changed parser.',
        evidence: [evidence()],
        coverage_obligation_ids: ['FILE-001']
    }];
    const ledger = ordinaryFindingReport.coverage_ledger as { entries: Array<Record<string, unknown>> };
    ledger.entries[0].finding_ids = ['F-001'];

    const ordinaryResult = validateReviewFindingsReport(ordinaryFindingReport, validationOptions);

    assert.equal(ordinaryResult.valid, false);
    assert.ok(ordinaryResult.violations.some((entry) => entry.includes('ordinary noncanonical finding')));

    const residualRiskReport = validReport();
    residualRiskReport.residual_risks = [{
        id: 'R-001',
        description: 'Prior focused execution evidence was absent for the changed parser.',
        evidence: [evidence()]
    }];

    const residualResult = validateReviewFindingsReport(residualRiskReport, validationOptions);

    assert.equal(residualResult.valid, false);
    assert.ok(residualResult.violations.some((entry) => entry.includes("Residual risk 'R-001' must not report")));
});

test('validateReviewFindingsReport rejects conflicting F-000 marker targets across title and description', () => {
    const sameTargetReport = missingFocusedValidationReport();
    const sameTargetFinding = (sameTargetReport.findings as Record<string, Array<Record<string, unknown>>>).medium[0];
    sameTargetFinding.description = sameTargetFinding.title;
    const sameTargetResult = validateReviewFindingsReport(sameTargetReport, validationOptions);
    assert.equal(sameTargetResult.valid, true, sameTargetResult.violations.join('\n'));

    const conflictingReport = missingFocusedValidationReport();
    const conflictingFinding = (conflictingReport.findings as Record<string, Array<Record<string, unknown>>>).medium[0];
    conflictingFinding.description =
        '[garda:evidence-only:missing-focused-validation] target=api/openapi.yaml; action=run-and-record-focused-validation';

    const conflictingResult = validateReviewFindingsReport(conflictingReport, validationOptions);

    assert.equal(conflictingResult.valid, false);
    assert.ok(conflictingResult.violations.some((entry) => entry.includes('must not declare different')));
    assert.ok(conflictingResult.violations.some((entry) => entry.includes("target 'api/openapi.yaml'")));
});

test('validateReviewFindingsReport rejects F-000 after a passing command or a Garda command', () => {
    const passed = missingFocusedValidationReport();
    (passed.validation_notes as Array<Record<string, unknown>>)[0].command_outcome = 'passed';
    const passedResult = validateReviewFindingsReport(passed, validationOptions);
    assert.equal(passedResult.valid, false);
    assert.ok(passedResult.violations.some((entry) => entry.includes('valid only when the target command outcome is unavailable or prohibited')));

    const garda = missingFocusedValidationReport();
    (garda.validation_notes as Array<Record<string, unknown>>)[0].command = 'node bin/garda.js gate run-intermediate-command';
    const gardaResult = validateReviewFindingsReport(garda, validationOptions);
    assert.equal(gardaResult.valid, false);
    assert.ok(gardaResult.violations.some((entry) => entry.includes('must not invoke Garda')));
});

test('validateReviewFindingsReport rejects F-000 when any matching attempt passed or failed', () => {
    for (const conflictingOutcome of ['passed', 'failed'] as const) {
        const report = missingFocusedValidationReport();
        const unavailableAttempt = (report.validation_notes as Array<Record<string, unknown>>)[0];
        report.validation_notes = [
            unavailableAttempt,
            {
                ...unavailableAttempt,
                id: 'N-002',
                note: 'The reviewer ran the matching focused command.',
                command_outcome: conflictingOutcome,
                diagnostics: conflictingOutcome === 'passed'
                    ? 'The focused target passed.'
                    : 'The focused target exposed an assertion failure.',
                finding_ids: conflictingOutcome === 'failed' ? ['F-001'] : undefined,
                evidence: [evidence('src/example.ts:10', 'The matching command result was recorded.')]
            }
        ];
        if (conflictingOutcome === 'failed') {
            (report.findings as Record<string, Array<Record<string, unknown>>>).high = [{
                id: 'F-001',
                title: 'Focused test exposed an implementation defect',
                description: 'The focused target assertion failed.',
                evidence: [evidence()],
                coverage_obligation_ids: ['FILE-001']
            }];
            const ledger = report.coverage_ledger as { entries: Array<Record<string, unknown>> };
            ledger.entries[0].finding_ids = ['F-000', 'F-001'];
        }

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, conflictingOutcome);
        assert.ok(result.violations.some((entry) => entry.includes('matching passed or failed attempt')), conflictingOutcome);
    }
});

test('validateReviewFindingsReport rejects F-000 for failed checks and mismatched marker targets', () => {
    const failed = missingFocusedValidationReport();
    (failed.validation_notes as Array<Record<string, unknown>>)[0].command_outcome = 'failed';
    (failed.validation_notes as Array<Record<string, unknown>>)[0].diagnostics = 'The target test assertion failed.';
    const failedResult = validateReviewFindingsReport(failed, validationOptions);
    assert.equal(failedResult.valid, false);
    assert.ok(failedResult.violations.some((entry) => entry.includes('failed must be an ordinary severity finding')));

    const mismatched = missingFocusedValidationReport();
    (mismatched.validation_notes as Array<Record<string, unknown>>)[0].command = 'node --test tests/node/other.test.ts';
    const mismatchedResult = validateReviewFindingsReport(mismatched, validationOptions);
    assert.equal(mismatchedResult.valid, false);
    assert.ok(mismatchedResult.violations.some((entry) => entry.includes("target 'tests/node/example.test.ts'")));
});

test('validateReviewFindingsReport requires failed focused checks to produce a linked ordinary finding', () => {
    const withoutFinding = validReport();
    withoutFinding.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The focused test for src/example.ts failed.',
        command: 'node --test tests/node/example.test.ts',
        command_outcome: 'failed',
        diagnostics: 'The changed parser assertion failed after returning an unexpected token.',
        finding_ids: [],
        evidence: [evidence(
            'src/example.ts:10',
            'The changed parser branch is covered by tests/node/example.test.ts.'
        )]
    }];
    const invalidResult = validateReviewFindingsReport(withoutFinding, validationOptions);
    assert.equal(invalidResult.valid, false);
    assert.ok(invalidResult.violations.some((entry) => entry.includes('requires an ordinary severity finding')));

    const withFinding = cloneReport(withoutFinding);
    (withFinding.validation_notes as Array<Record<string, unknown>>)[0].finding_ids = ['F-001'];
    (withFinding.findings as Record<string, Array<Record<string, unknown>>>).high = [{
        id: 'F-001',
        title: 'Focused test exposed an implementation defect',
        description: 'The changed implementation fails its focused assertion.',
        evidence: [evidence()],
        coverage_obligation_ids: ['FILE-001']
    }];
    const ledger = withFinding.coverage_ledger as { entries: Array<Record<string, unknown>> };
    ledger.entries[0].finding_ids = ['F-001'];

    const validResult = validateReviewFindingsReport(withFinding, validationOptions);
    assert.equal(validResult.valid, true, validResult.violations.join('\n'));
});

test('validateReviewFindingsReport rejects failed focused checks linked to an unknown finding id', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The focused test failed.',
        command: 'node --test tests/node/example.test.ts',
        command_outcome: 'failed',
        diagnostics: 'The changed parser assertion failed after returning an unexpected token.',
        finding_ids: ['F-999'],
        evidence: [evidence()]
    }];
    (report.findings as Record<string, Array<Record<string, unknown>>>).high = [{
        id: 'F-001',
        title: 'Unrelated defect in the same file',
        description: 'A separate behavior is incorrect.',
        evidence: [evidence()],
        coverage_obligation_ids: ['FILE-001']
    }];
    const ledger = report.coverage_ledger as { entries: Array<Record<string, unknown>> };
    ledger.entries[0].finding_ids = ['F-001'];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("references unknown ordinary finding id 'F-999'")));
});

test('validateReviewFindingsReport rejects failed focused checks linked to unrelated evidence', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The focused test for the changed parser failed.',
        command: 'node --test tests/node/example.test.ts',
        command_outcome: 'failed',
        diagnostics: 'The changed parser assertion failed.',
        finding_ids: ['F-001'],
        evidence: [evidence('src/example.ts:10', 'This parser branch motivated the focused test.')]
    }];
    (report.findings as Record<string, Array<Record<string, unknown>>>).high = [{
        id: 'F-001',
        title: 'Unrelated defect elsewhere in the same file',
        description: 'A separate branch has an unrelated defect.',
        evidence: [evidence('src/example.ts:20', 'This evidence does not identify the failed parser branch.')],
        coverage_obligation_ids: ['FILE-001']
    }];
    const ledger = report.coverage_ledger as { entries: Array<Record<string, unknown>> };
    ledger.entries[0].finding_ids = ['F-001'];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('must share at least one exact changed-file evidence location')));
});

test('validateReviewFindingsReport compares failed focused finding evidence locations case-sensitively', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The focused test for the changed parser failed.',
        command: 'node --test tests/node/example.test.ts',
        command_outcome: 'failed',
        diagnostics: 'The changed parser assertion failed after returning an unexpected token.',
        finding_ids: ['F-001'],
        evidence: [evidence(
            'src/Example.ts:10',
            'The changed parser branch is covered by tests/node/example.test.ts.'
        )]
    }];
    (report.findings as Record<string, Array<Record<string, unknown>>>).high = [{
        id: 'F-001',
        title: 'Focused test exposed an implementation defect',
        description: 'The changed implementation fails its focused assertion.',
        evidence: [evidence('src/example.ts:10', 'The exact failed parser branch was inspected.')],
        coverage_obligation_ids: ['FILE-001']
    }];
    const ledger = report.coverage_ledger as { entries: Array<Record<string, unknown>> };
    ledger.entries[0].finding_ids = ['F-001'];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes(
        'must share at least one exact changed-file evidence location'
    )));
});

test('validateReviewFindingsReport rejects Garda focused commands without an F-000 finding', () => {
    for (const command of [
        'node bin/garda.js gate run-intermediate-command',
        'node garda-agent-orchestrator/bin/garda.js next-step T-979-48',
        'node C:\\repo\\bin\\garda.js gate compile-gate',
        'node "C:\\repo path\\bin\\garda.js" gate compile-gate',
        'npx garda gate compile-gate',
        'pnpm exec garda gate compile-gate',
        'yarn garda next-step T-979-48',
        'bunx garda gate compile-gate',
        'garda status'
    ]) {
        const report = validReport();
        report.validation_notes = [{
            id: 'N-001',
            topic: 'focused-self-validation',
            note: 'The reviewer attempted a narrow check.',
            command,
            command_outcome: 'passed',
            diagnostics: 'The command passed.',
            evidence: [evidence()]
        }];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, command);
        assert.ok(result.violations.some((entry) => entry.includes('must not invoke Garda')), command);
    }
});

test('validateReviewFindingsReport permits safe targets whose path segments look like blocked commands', () => {
    for (const target of [
        'service/config.yaml',
        'curl/config.yaml',
        'touch/config.yaml',
        'git/clone.yaml'
    ]) {
        const report = validReport();
        report.validation_notes = [{
            id: 'N-001',
            topic: 'focused-self-validation',
            note: 'The reviewer ran one safe local contract validation.',
            command: `node tools/validate-contract.js ${target}`,
            command_outcome: 'passed',
            diagnostics: 'The focused contract validator completed twelve checks successfully.',
            evidence: [evidence(
                'src/example.ts:10',
                `The changed parser consumes ${target}, which motivated the focused validation.`
            )]
        }];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, true, `${target}\n${result.violations.join('\n')}`);
    }
});

test('validateReviewFindingsReport rejects unsafe network, mutation, and background focused commands', () => {
    const unsafeCommands = [
        ['curl https://example.test/health', 'network services'],
        ['node -e "require(\'fs\').writeFileSync(\'src/example.ts\',\'x\')"', 'mutate source'],
        ['node -e "require(\'fs\').promises.writeFile(\'src/example.ts\',\'x\')"', 'mutate source'],
        ['node -p "1 + 1"', 'inline interpreter'],
        ['node scripts/check.js "require(\'node:fs\').mkdirSync(\'reviewer-created\')"', 'mutate source'],
        ['Set-Content src/example.ts x', 'mutate source'],
        ['touch src/example.ts', 'mutate source'],
        ['node --test tests/node/example.test.ts $(curl https://example.test/data)', 'shell command substitutions'],
        ['node --test tests/node/example.test.ts `touch reviewer-created`', 'shell command substitutions'],
        ['node --test tests/node/{example,other}.test.ts', 'shell variable, brace, bracket, or home expansions'],
        ['node --test tests/node/[eo]xample.test.ts', 'shell variable, brace, bracket, or home expansions'],
        ['node --test $TEST_TARGET', 'shell variable, brace, bracket, or home expansions'],
        ['node --test <(curl https://example.test/data)', 'shell redirection, process expansion, escaping, or response-file expansion'],
        ['node --test @tests/node/focused-targets.txt', 'shell redirection, process expansion, escaping, or response-file expansion'],
        ['node --test !TEST_TARGET!', 'shell redirection, process expansion, escaping, or response-file expansion'],
        ['eslint --fix src/example.ts', 'validation-runner flags that may mutate source files or snapshots'],
        ['prettier --write src/example.ts', 'validation-runner flags that may mutate source files or snapshots'],
        ['jest -u tests/node/example.test.ts', 'validation-runner flags that may mutate source files or snapshots'],
        ['npx vitest tests/node/example.test.ts', 'package-execution wrappers that may fetch dependencies implicitly'],
        ['bunx vitest tests/node/example.test.ts', 'package-execution wrappers that may fetch dependencies implicitly'],
        ['pnpm dlx vitest tests/node/example.test.ts', 'package-execution wrappers that may fetch dependencies implicitly'],
        ['npm --silent exec vitest tests/node/example.test.ts', 'package-execution wrappers that may fetch dependencies implicitly'],
        ['node --no-warnings -e "fetch(\'https://example.test/data\')" tests/node/example.test.ts', 'inline interpreter'],
        ['node --test --test-reporter-destination=src/core/templates.ts tests/node/example.test.ts', 'write output artifacts'],
        ['node --test --watch tests/node/example.test.ts', 'interactive, watching, serving, or debugger'],
        ['node --inspect --test tests/node/example.test.ts', 'interactive, watching, serving, or debugger'],
        ['node --test --cache-location=src/core/templates.ts tests/node/example.test.ts', 'unrecognized validation-runner options'],
        ['python --check src/example.js', 'unrecognized validation-runner options'],
        ['eslint --check src/example.js', 'unrecognized validation-runner options'],
        ['node src/example.js --check', 'unrecognized validation-runner options'],
        ['node -- --check src/example.js', 'unrecognized validation-runner options'],
        ['node --check=src/example.js src/example.js', 'unrecognized validation-runner options'],
        ['node --check --require src/preload.js src/example.js', 'unrecognized validation-runner options'],
        ['node --test tests/../outside.test.ts', 'escape authenticated repository scope'],
        ['node --test C:outside.test.ts', 'escape authenticated repository scope'],
        ['tsc src/example.ts', 'without --noEmit'],
        ['start node scripts/check.js tests/node/example.test.ts', 'background processes'],
        ['node server.js &', 'background processes'],
        ['npm test', 'broad build'],
        ['npm --silent test', 'broad build'],
        ['node --test tests/node/example.test.ts; npm test', 'chain or pipe'],
        ['node --test', 'broad build'],
        ['node scripts/node-foundation/build-scripts.cjs test.js', 'broad build']
    ] as const;
    for (const [command, expectedViolation] of unsafeCommands) {
        const report = validReport();
        report.validation_notes = [{
            id: 'N-001',
            topic: 'focused-self-validation',
            note: 'The reviewer attempted a narrow check.',
            command,
            command_outcome: 'unavailable',
            diagnostics: 'The command was blocked.',
            evidence: [evidence()]
        }];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, command);
        assert.ok(result.violations.some((entry) => entry.includes(expectedViolation)), command);
    }
});

test('validateReviewFindingsReport accepts passed no-findings validation without a duplicate evidence target', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The reviewer ran tests/node/example.test.ts.',
        command: 'node --test tests/node/example.test.ts',
        command_outcome: 'passed',
        diagnostics: 'The parser-focused assertions completed without any reported failures.',
        evidence: [evidence('src/example.ts:10', 'The changed parser branch motivated a focused check.')]
    }];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, true, result.violations.join('\n'));
});

test('validateReviewFindingsReport accepts a no-findings focused target named by authenticated evidence location', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The reviewer ran the smallest relevant changed test target.',
        command: 'node --test tests/node/example.test.ts',
        command_outcome: 'passed',
        diagnostics: 'The focused target completed thirty tests without any reported failures.',
        evidence: [evidence(
            'tests/node/example.test.ts:42',
            'This changed test directly exercises the parser behavior reviewed in the assigned scope.'
        )]
    }];

    const result = validateReviewFindingsReport(report, {
        ...validationOptions,
        expectedChangedFilePaths: ['src/example.ts', 'tests/node/example.test.ts']
    });

    assert.equal(result.valid, true, result.violations.join('\n'));
});

test('validateReviewFindingsReport accepts passed no-findings validation with a different authenticated evidence path', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The reviewer ran a focused test target.',
        command: 'node --test tests/node/example.test.ts',
        command_outcome: 'passed',
        diagnostics: 'The focused target completed thirty tests without any reported failures.',
        evidence: [evidence(
            'tests/node/example.test.ts.backup:42',
            'This changed backup file motivated a focused local check.'
        )]
    }];

    const result = validateReviewFindingsReport(report, {
        ...validationOptions,
        expectedChangedFilePaths: ['src/example.ts', 'tests/node/example.test.ts.backup']
    });

    assert.equal(result.valid, true, result.violations.join('\n'));
});

test('validateReviewFindingsReport accepts passed validation without duplicate target when findings exist', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The reviewer ran a focused test target before reporting an ordinary finding.',
        command: 'node --test tests/node/example.test.ts',
        command_outcome: 'passed',
        diagnostics: 'The focused target completed thirty tests without any reported failures.',
        evidence: [evidence('src/example.ts:10', 'The changed parser branch motivated a focused local check.')]
    }];
    report.findings = {
        critical: [],
        high: [],
        medium: [{
            id: 'F-001',
            title: 'Parser rejects a supported input',
            description: 'The changed parser branch rejects one supported input outside the focused target.',
            evidence: [evidence()],
            coverage_obligation_ids: ['FILE-001']
        }],
        low: []
    };
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [evidence()],
                finding_ids: ['F-001']
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                finding_ids: []
            }
        ]
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, true, result.violations.join('\n'));
});

test('validateReviewFindingsReport rejects traversal in focused marker targets and commands', () => {
    const report = missingFocusedValidationReport();
    const finding = (report.findings as Record<string, Array<Record<string, unknown>>>).medium[0];
    finding.title = '[garda:evidence-only:missing-focused-validation] target=api/../../outside.yaml; action=run-and-record-focused-validation';
    const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
    note.note = 'The reviewer attempted api/../../outside.yaml.';
    note.command = 'node tools/validate-contract.js api/../../outside.yaml';

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('repository-relative path without dot segments')));
});

test('validateReviewFindingsReport rejects unavailable F-000 attempts without exact evidence-to-target binding', () => {
    for (const observation of [
        'The changed parser branch motivated a local check.',
        'The changed parser branch is covered by tests/node/example.test.ts.backup.',
        'The changed parser branch is covered by Tests/node/example.test.ts.'
    ]) {
        const report = missingFocusedValidationReport();
        const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
        note.note = 'The reviewer attempted tests/node/example.test.ts as a local check.';
        note.diagnostics = 'The isolated runtime cannot execute tests/node/example.test.ts because the loader is absent.';
        note.evidence = [evidence('src/example.ts:10', observation)];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, observation);
        assert.ok(
            result.violations.some((entry) => entry.includes('name the exact focused command target')),
            `${observation}\n${result.violations.join('\n')}`
        );
    }
});

test('validateReviewFindingsReport rejects forged unavailable F-000 evidence whose location names the target without relevance rationale', () => {
    const report = missingFocusedValidationReport();
    const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
    note.evidence = [evidence(
        'tests/node/example.test.ts:1',
        'The reviewer selected one focused repository target.'
    )];

    const result = validateReviewFindingsReport(report, {
        ...validationOptions,
        expectedChangedFilePaths: ['src/example.ts', 'tests/node/example.test.ts']
    });

    assert.equal(result.valid, false, result.violations.join('\n'));
    assert.ok(result.violations.some((entry) => entry.includes(
        'name the exact focused command target and why it is relevant'
    )));
});

test('validateReviewFindingsReport accepts unavailable focused relevance split across location and observation', () => {
    const report = missingFocusedValidationReport();
    const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
    note.evidence = [evidence(
        'tests/node/example.test.ts:42',
        'This changed routing test directly covers the frozen behavior under review.'
    )];

    const result = validateReviewFindingsReport(report, {
        ...validationOptions,
        expectedChangedFilePaths: ['src/example.ts', 'tests/node/example.test.ts']
    });

    assert.equal(result.valid, true, result.violations.join('\n'));
});

test('validateReviewFindingsReport rejects lexical-only focused target relevance claims', () => {
    for (const observation of [
        'tests/node/example.test.ts is the focused test target.',
        'tests/node/example.test.ts is relevant to this check.',
        'tests/node/example.test.ts tests changed behavior.',
        'The changed branch targets tests/node/example.test.ts.'
    ]) {
        const report = missingFocusedValidationReport();
        const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
        note.evidence = [evidence('src/example.ts:10', observation)];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, observation);
        assert.ok(
            result.violations.some((entry) => entry.includes(
                'name the exact focused command target and why it is relevant'
            )),
            `${observation}\n${result.violations.join('\n')}`
        );
    }
});

test('validateReviewFindingsReport rejects focused targets disconnected from the relevance rationale', () => {
    for (const observation of [
        'The reviewer selected tests/node/example.test.ts. The changed parser is covered by tests/node/relevant.test.ts.',
        'tests/node/example.test.ts is an available target; the changed parser is validated by tests/node/relevant.test.ts.',
        'The reviewer named tests/node/example.test.ts, whereas tests/node/relevant.test.ts covers the changed parser.'
    ]) {
        const report = missingFocusedValidationReport();
        const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
        note.evidence = [evidence('src/example.ts:10', observation)];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, observation);
        assert.ok(
            result.violations.some((entry) => entry.includes(
                'name the exact focused command target and why it is relevant'
            )),
            `${observation}\n${result.violations.join('\n')}`
        );
    }
});

test('validateReviewFindingsReport explains the single-clause focused evidence contract', () => {
    for (const observation of [
        'The focused command target tests/node/example.test.ts exercises this parser assertion; it validates the changed behavior.',
        'The focused command target tests/node/example.test.ts exercises this parser assertion\nIt validates the changed behavior.',
        'The focused command target tests/node/example.test.ts exercises this parser assertion, but it validates the affected behavior.',
        'The focused command target tests/node/example.test.ts exercises this parser assertion, however, it validates the affected behavior.',
        'The focused command target tests/node/example.test.ts exercises this parser assertion while it validates the affected behavior.'
    ]) {
        const report = missingFocusedValidationReport();
        const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
        note.evidence = [evidence('src/example.ts:10', observation)];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, false, result.violations.join('\n'));
        assert.ok(result.violations.some((entry) => (
            entry.includes('why it is relevant in one clause')
            && entry.includes('Semicolons, newlines, sentence punctuation')
            && entry.includes('affected/changed/modified/new/updated')
        )), result.violations.join('\n'));
    }
});

test('validateReviewFindingsReport accepts a focused target tied to changed behavior by a concrete relationship', () => {
    for (const observation of [
        'tests/node/example.test.ts validates the changed parser branch.',
        'tests/node/example.test.ts validates the affected parser branch.'
    ]) {
        const report = missingFocusedValidationReport();
        const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
        note.evidence = [evidence('src/example.ts:10', observation)];

        const result = validateReviewFindingsReport(report, validationOptions);

        assert.equal(result.valid, true, `${observation}\n${result.violations.join('\n')}`);
    }
});

test('validateReviewFindingsReport accepts a focused target tied to the authenticated task contract', () => {
    const report = missingFocusedValidationReport();
    const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
    note.evidence = [evidence(
        'tests/node/example.test.ts:42',
        "The focused command target tests/node/example.test.ts is relevant to T-979-1 because it asserts T-979-1's oversized-timeline rejection contract."
    )];

    const result = validateReviewFindingsReport(report, {
        ...validationOptions,
        expectedChangedFilePaths: ['src/example.ts', 'tests/node/example.test.ts']
    });

    assert.equal(result.valid, true, result.violations.join('\n'));
});

test('validateReviewFindingsReport rejects a focused target tied to another task contract', () => {
    for (const otherTaskId of ['T-978', 'T-979-1-forged']) {
        const report = missingFocusedValidationReport();
        const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
        note.evidence = [evidence(
            'tests/node/example.test.ts:42',
            `The focused command target tests/node/example.test.ts is relevant to ${otherTaskId} because it asserts ${otherTaskId}'s oversized-timeline rejection contract.`
        )];

        const result = validateReviewFindingsReport(report, {
            ...validationOptions,
            expectedChangedFilePaths: ['src/example.ts', 'tests/node/example.test.ts']
        });

        assert.equal(result.valid, false, otherTaskId);
        assert.ok(result.violations.some((entry) => entry.includes(
            'name the exact focused command target and why it is relevant'
        )), otherTaskId);
    }
});

test('validateReviewFindingsReport rejects an existing but unrelated F-000 target with repo context', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-focused-unrelated-target-'));
    try {
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'tests', 'node'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'example.ts'),
            Array.from({ length: 25 }, (_, index) => `// line ${index + 1}`).join('\n') + '\n',
            'utf8'
        );
        fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'example.test.ts'), 'export {};\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'relevant.test.ts'), 'export {};\n', 'utf8');
        const report = missingFocusedValidationReport();
        const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
        note.evidence = [evidence(
            'src/example.ts:10',
            'The changed parser is covered by tests/node/relevant.test.ts, which is unrelated to the attempted target.'
        )];

        const result = validateReviewFindingsReport(report, { ...validationOptions, repoRoot });

        assert.equal(result.valid, false, result.violations.join('\n'));
        assert.ok(result.violations.some((entry) => entry.includes(
            'name the exact focused command target'
        )));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateReviewFindingsReport permits focused test paths whose names include next-step', () => {
    const report = missingFocusedValidationReport();
    const finding = (report.findings as Record<string, Array<Record<string, unknown>>>).medium[0];
    finding.title = '[garda:evidence-only:missing-focused-validation] test=tests/node/gates/next-step/example.test.ts; action=run-and-record-focused-test';
    const note = (report.validation_notes as Array<Record<string, unknown>>)[0];
    note.note = 'Prior focused execution for tests/node/gates/next-step/example.test.ts was absent, so the reviewer attempted that smallest local check.';
    note.command = 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/next-step/example.test.ts';
    note.evidence = [evidence(
        'src/example.ts:10',
        'The changed next-step parser is covered by tests/node/gates/next-step/example.test.ts.'
    )];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, true, result.violations.join('\n'));
});

test('validateReviewFindingsReport permits a focused test file named garda.js without invoking Garda', () => {
    const report = validReport();
    report.validation_notes = [{
        id: 'N-001',
        topic: 'focused-self-validation',
        note: 'The reviewer ran the focused Garda-name collision regression.',
        command: 'node --test tests/garda.js',
        command_outcome: 'passed',
        diagnostics: 'The focused name-collision test completed twelve assertions successfully.',
        evidence: [evidence(
            'src/example.ts:10',
            'The changed parser is covered by tests/garda.js without invoking the Garda CLI.'
        )]
    }];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, true, result.violations.join('\n'));
});

test('validateReviewFindingsReport rejects empty validation notes', () => {
    const report = validReport();
    report.validation_notes = [];

    const schemaViolations = jsonSchemaViolations(report);
    const result = validateReviewFindingsReport(report, validationOptions);

    assert.ok(schemaViolations.some((entry) => entry.includes('$.validation_notes must contain at least 1 item')));
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('validation_notes must contain at least one validation note')));
});

test('validateReviewFindingsReport rejects empty findings when expected coverage obligations are omitted', () => {
    const result = validateReviewFindingsReport(validReport(), {
        expectedTaskId: 'T-979-1',
        expectedReviewType: 'code',
        expectedChangedFilePaths: ['src/example.ts'],
        expectedReviewContextSha256: HASH_A,
        expectedTreeStateSha256: HASH_B
    });

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('Empty findings require expected coverage obligation ids')));
});

test('validateReviewFindingsReport rejects non-concrete JSON coverage evidence locations when current changed files are known', () => {
    const report = validReport();
    ((report.coverage_ledger as Record<string, unknown>).entries as Array<Record<string, unknown>>)[0].evidence = [
        evidence('<changed-file>:<line>', 'Placeholder evidence should not satisfy coverage.')
    ];
    ((report.coverage_ledger as Record<string, unknown>).entries as Array<Record<string, unknown>>)[1].evidence = [
        evidence('tests/example.test.ts:20', 'A non-changed file should not satisfy current coverage.')
    ];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes(
        "coverage_ledger.entries[0].evidence[0].location '<changed-file>:<line>' is outside the code review evidence domain"
    )));
    assert.ok(result.violations.some((entry) => entry.includes(
        "expected path:line from one of: src/example.ts"
    )));
    assert.ok(result.violations.some((entry) => entry.includes(
        'Supporting artifacts may inform observations but are not admissible location evidence'
    )));
});

test('validateReviewFindingsReport rejects non-concrete evidence locations outside the coverage ledger', () => {
    const report = validReport();
    (report.validation_notes as Array<Record<string, unknown>>)[0].evidence = [
        evidence('<changed-file>:<line>', 'Placeholder validation note evidence should not pass.')
    ];
    (report.findings as Record<string, unknown>).medium = [{
        id: 'F-001',
        title: 'Concrete evidence validation gap',
        description: 'Finding evidence must be bound to a current changed file.',
        evidence: [evidence('tests/example.test.ts:20', 'A non-changed finding evidence location should not pass.')],
        coverage_obligation_ids: ['FILE-001']
    }];
    report.residual_risks = [{
        id: 'R-001',
        description: 'Residual risk evidence must be bound to a current changed file.',
        evidence: [evidence('src/other.ts:10', 'A non-changed residual risk evidence location should not pass.')]
    }];
    ((report.coverage_ledger as Record<string, unknown>).entries as Array<Record<string, unknown>>)[0].finding_ids = ['F-001'];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes(
        "validation_notes[0].evidence[0].location '<changed-file>:<line>' is outside the code review evidence domain"
    )));
    assert.ok(result.violations.some((entry) => entry.includes(
        "findings.medium[0].evidence[0].location 'tests/example.test.ts:20' is outside the code review evidence domain"
    )));
    assert.ok(result.violations.some((entry) => entry.includes(
        "residual_risks[0].evidence[0].location 'src/other.ts:10' is outside the code review evidence domain"
    )));
});

test('validateReviewFindingsReport keeps supplementary validation-note evidence nonblocking when no findings exist', () => {
    const report = validReport();
    (report.validation_notes as Array<Record<string, unknown>>)[0].evidence = [
        evidence(
            'src/example.ts:20',
            'Supplementary test evidence must not turn an otherwise valid no-findings review into another review cycle.'
        )
    ];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, true, result.violations.join('\n'));
    assert.equal(result.report?.findings.critical.length, 0);
    assert.equal(result.report?.findings.high.length, 0);
    assert.equal(result.report?.findings.medium.length, 0);
    assert.equal(result.report?.findings.low.length, 0);
    assert.equal(result.report?.residual_risks.length, 0);
});

test('validateReviewFindingsReport rejects unauthenticated validation-note evidence when no findings exist', () => {
    const report = validReport();
    (report.validation_notes as Array<Record<string, unknown>>)[0].evidence = [
        evidence(
            'tests/example.test.ts:20',
            'Supplementary evidence must remain bound to the authenticated review domain.'
        )
    ];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes(
        "validation_notes[0].evidence[0].location 'tests/example.test.ts:20' is outside the code review evidence domain"
    )));
});

test('validateReviewFindingsContract authenticates non-ledger evidence line numbers', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-findings-lines-'));
    try {
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'example.ts'), 'export const example = 1;\n', 'utf8');
        const contract = buildReviewCoverageContract({
            reviewType: 'code',
            changedFiles: ['src/example.ts'],
            categoryIds: ['schema']
        });
        const report = validReport();
        report.coverage_ledger = {
            coverage_contract_sha256: contract.contract_sha256,
            entries: contract.obligations.map((obligation, index) => ({
                obligation_id: obligation.id,
                evidence: [
                    evidence(
                        'src/example.ts:1',
                        `Concrete current-file evidence covers ${obligation.kind} obligation ${index + 1}.`
                    )
                ],
                finding_ids: index === 0 ? ['F-001'] : []
            }))
        };
        (report.validation_notes as Array<Record<string, unknown>>)[0].evidence = [
            evidence('src/example.ts:999', 'Validation-note evidence points beyond the current file.')
        ];
        (report.findings as Record<string, unknown>).medium = [{
            id: 'F-001',
            title: 'Out-of-range non-ledger evidence',
            description: 'Finding evidence must be authenticated against current changed-file line counts.',
            evidence: [evidence('src/example.ts:999', 'Finding evidence points beyond the current file.')],
            coverage_obligation_ids: [contract.obligations[0].id]
        }];
        report.residual_risks = [{
            id: 'R-001',
            description: 'Residual risk evidence must be authenticated against current changed-file line counts.',
            evidence: [evidence('src/example.ts:999', 'Residual-risk evidence points beyond the current file.')]
        }];

        const result = validateReviewFindingsContract({
            content: JSON.stringify(report),
            expectedTaskId: 'T-979-1',
            expectedReviewType: 'code',
            expectedReviewContextSha256: HASH_A,
            expectedTreeStateSha256: HASH_B,
            coverageContract: contract,
            repoRoot
        });

        assert.equal(result.detected, true);
        assert.equal(result.valid, false);
        assert.ok(result.violations.some((entry) => entry.includes(
            "validation_notes[0].evidence[0].location 'src/example.ts:999' exceeds current file line count 1"
        )));
        assert.ok(result.violations.some((entry) => entry.includes(
            "findings.medium[0].evidence[0].location 'src/example.ts:999' exceeds current file line count 1"
        )));
        assert.ok(result.violations.some((entry) => entry.includes(
            "residual_risks[0].evidence[0].location 'src/example.ts:999' exceeds current file line count 1"
        )));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateReviewFindingsReport rejects empty findings when expected coverage is incomplete', () => {
    const report = validReport();
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [{
            obligation_id: 'FILE-001',
            evidence: [evidence()],
            finding_ids: []
        }]
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("Expected coverage obligation 'CATEGORY-SCHEMA'")));
});

test('validateReviewFindingsReport accepts critical, high, medium, and low findings bound to coverage evidence', () => {
    const report = validReport();
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [evidence()],
                finding_ids: ['F-001', 'F-002', 'F-003']
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                finding_ids: ['F-004']
            }
        ]
    };
    report.findings = {
        critical: [{
            id: 'F-001',
            title: 'Unrepresentable critical finding',
            description: 'The schema accepts critical severity findings.',
            evidence: [evidence()],
            coverage_obligation_ids: ['FILE-001']
        }],
        high: [{
            id: 'F-002',
            title: 'Missing task binding',
            description: 'The schema accepts a foreign task identifier.',
            evidence: [evidence()],
            coverage_obligation_ids: ['FILE-001']
        }],
        medium: [{
            id: 'F-003',
            title: 'Missing review binding',
            description: 'The schema accepts a foreign review type.',
            evidence: [evidence('src/example.ts:11', 'Concrete review-type branch was inspected')],
            coverage_obligation_ids: ['FILE-001']
        }],
        low: [{
            id: 'F-004',
            title: 'Weak reviewer note validation',
            description: 'The schema accepts empty reviewer notes.',
            evidence: [evidence('src/example.ts:20', 'Concrete note validation branch was inspected')],
            coverage_obligation_ids: ['CATEGORY-SCHEMA']
        }]
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, true);
    assert.deepEqual(result.report?.findings.critical.map((entry) => entry.id), ['F-001']);
    assert.deepEqual(result.report?.findings.high.map((entry) => entry.id), ['F-002']);
    assert.deepEqual(result.violations, []);
});

test('validateReviewFindingsReport rejects unknown and reviewer-owned verdict fields', () => {
    const report = validReport();
    report.verdict = 'REVIEW PASSED';
    (report.validation_notes as Array<Record<string, unknown>>)[0].passed = true;

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("unknown field 'verdict'")));
    assert.ok(result.violations.some((entry) => entry.includes('$.verdict is a reviewer-owned verdict')));
    assert.ok(result.violations.some((entry) => entry.includes('$.validation_notes[0].passed')));
});

test('validateReviewFindingsReport rejects duplicate ids and missing concrete evidence', () => {
    const report = validReport();
    report.findings = {
        critical: [],
        high: [
            {
                id: 'F-001',
                title: 'Duplicate finding',
                description: 'First duplicate instance.',
                evidence: [evidence()],
                coverage_obligation_ids: ['FILE-001']
            },
            {
                id: 'F-001',
                title: 'Duplicate finding again',
                description: 'Second duplicate instance.',
                evidence: [],
                coverage_obligation_ids: ['FILE-001']
            }
        ],
        medium: [],
        low: []
    };
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [],
                finding_ids: ['F-001']
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                finding_ids: []
            }
        ]
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("Duplicate finding id 'F-001'")));
    assert.ok(result.violations.some((entry) => entry.includes('findings.high[1].evidence must contain')));
    assert.ok(result.violations.some((entry) => entry.includes('coverage_ledger.entries[0].evidence must contain')));
});

test('validateReviewFindingsReport rejects duplicate ids in every id-bearing section', () => {
    const report = validReport();
    report.validation_notes = [
        {
            id: 'N-001',
            topic: 'schema-shape',
            note: 'First validation note.',
            evidence: [evidence()]
        },
        {
            id: 'N-001',
            topic: 'schema-shape-again',
            note: 'Second validation note with duplicate id.',
            evidence: [evidence('src/example.ts:11', 'Duplicate validation note id branch was inspected')]
        }
    ];
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [evidence()],
                finding_ids: []
            },
            {
                obligation_id: 'FILE-001',
                evidence: [evidence('src/example.ts:20', 'Duplicate coverage obligation id branch was inspected')],
                finding_ids: []
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:30', 'Expected coverage obligation remains represented')],
                finding_ids: []
            }
        ]
    };
    report.residual_risks = [
        {
            id: 'R-001',
            description: 'First residual risk.',
            evidence: [evidence('src/example.ts:40', 'First residual risk id branch was inspected')]
        },
        {
            id: 'R-001',
            description: 'Second residual risk with duplicate id.',
            evidence: [evidence('src/example.ts:41', 'Duplicate residual risk id branch was inspected')]
        }
    ];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("Duplicate validation note id 'N-001'")));
    assert.ok(result.violations.some((entry) => entry.includes("Duplicate coverage obligation id 'FILE-001'")));
    assert.ok(result.violations.some((entry) => entry.includes("Duplicate residual risk id 'R-001'")));
});

test('validateReviewFindingsReport rejects task, review, context, and tree-state mismatches', () => {
    const report = validReport();
    report.task_id = 'T-OTHER';
    report.review_type = 'security';
    report.review_context_sha256 = 'd'.repeat(64);
    report.tree_state_sha256 = 'e'.repeat(64);

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("task_id 'T-OTHER'")));
    assert.ok(result.violations.some((entry) => entry.includes("review_type 'security'")));
    assert.ok(result.violations.some((entry) => entry.includes('review_context_sha256 does not match')));
    assert.ok(result.violations.some((entry) => entry.includes('tree_state_sha256 does not match')));
});

test('validateReviewFindingsReport rejects coverage/finding cross-reference drift', () => {
    const report = validReport();
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [evidence()],
                finding_ids: ['F-999']
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                finding_ids: []
            }
        ]
    };
    report.findings = {
        critical: [],
        high: [{
            id: 'F-001',
            title: 'Unlinked finding',
            description: 'The finding is not referenced by coverage.',
            evidence: [evidence()],
            coverage_obligation_ids: ['CATEGORY-UNKNOWN']
        }],
        medium: [],
        low: []
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("Finding 'F-001' references unknown coverage obligation")));
    assert.ok(result.violations.some((entry) => entry.includes("Finding 'F-001' is not referenced")));
    assert.ok(result.violations.some((entry) => entry.includes("Coverage ledger references unknown finding 'F-999'")));
});

test('validateReviewFindingsReport rejects per-obligation coverage and finding reciprocity drift', () => {
    const report = validReport();
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [evidence()],
                finding_ids: []
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                finding_ids: ['F-001']
            }
        ]
    };
    report.findings = {
        critical: [],
        high: [{
            id: 'F-001',
            title: 'Partially linked finding',
            description: 'The finding and coverage ledger disagree about the exact obligations exposing the issue.',
            evidence: [evidence()],
            coverage_obligation_ids: ['FILE-001']
        }],
        medium: [],
        low: []
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes(
        "Finding 'F-001' references coverage obligation 'FILE-001' but that coverage ledger entry does not reference the finding"
    )));
    assert.ok(result.violations.some((entry) => entry.includes(
        "Coverage ledger entry 'CATEGORY-SCHEMA' references finding 'F-001' but that finding does not reference the coverage obligation"
    )));
});

test('validateReviewFindingsContract returns one deterministic violation set for malformed findings and coverage', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: ['schema']
    });
    const fileObligation = contract.obligations.find((entry) => entry.kind === 'file');
    const categoryObligation = contract.obligations.find((entry) => entry.kind === 'category');
    assert.ok(fileObligation);
    assert.ok(categoryObligation);
    const report = {
        ...validReport(),
        task_id: 'T-OTHER',
        review_context_sha256: 'd'.repeat(64),
        tree_state_sha256: 'e'.repeat(64),
        verdict: 'REVIEW PASSED',
        coverage_ledger: {
            coverage_contract_sha256: 'f'.repeat(64),
            entries: [
                {
                    obligation_id: fileObligation.id,
                    evidence: [evidence('src/example.ts:10', 'Reviewed the whole file')],
                    finding_ids: ['F-999']
                },
                {
                    obligation_id: fileObligation.id,
                    evidence: [],
                    finding_ids: []
                },
                {
                    obligation_id: 'CATEGORY-UNKNOWN',
                    evidence: [evidence('tests/outside.test.ts:2', 'Concrete unknown category evidence was inspected')],
                    finding_ids: []
                }
            ]
        },
        findings: {
            critical: [],
            high: [
                {
                    id: 'F-001',
                    title: 'Unlinked category finding',
                    description: 'The finding references an omitted system-owned category obligation.',
                    evidence: [evidence('tests/outside.test.ts:2', 'Concrete outside-scope finding evidence was inspected')],
                    coverage_obligation_ids: [categoryObligation.id]
                },
                {
                    id: 'F-001',
                    title: 'Duplicate finding without evidence',
                    description: 'The duplicate finding is malformed and must not hide later coverage failures.',
                    evidence: [],
                    coverage_obligation_ids: [fileObligation.id]
                }
            ],
            medium: [],
            low: []
        },
        residual_risks: [{
            id: 'RISK-001',
            description: 'Malformed residual risk shape must be reported with the same result.',
            evidence: []
        }]
    };

    const first = validateReviewFindingsContract({
        content: JSON.stringify(report),
        expectedTaskId: 'T-979-1',
        expectedReviewType: 'code',
        expectedReviewContextSha256: HASH_A,
        expectedTreeStateSha256: HASH_B,
        coverageContract: contract
    });
    const second = validateReviewFindingsContract({
        content: JSON.stringify(report),
        expectedTaskId: 'T-979-1',
        expectedReviewType: 'code',
        expectedReviewContextSha256: HASH_A,
        expectedTreeStateSha256: HASH_B,
        coverageContract: contract
    });

    assert.equal(first.detected, true);
    assert.equal(first.valid, false);
    assert.equal(first.report, null);
    assert.equal(first.coverage_validation?.status, 'FAIL');
    assert.deepEqual(second.violations, first.violations);
    assert.ok(first.violations.some((entry) => entry.includes("unknown field 'verdict'")));
    assert.ok(first.violations.some((entry) => entry.includes('$.verdict is a reviewer-owned verdict')));
    assert.ok(first.violations.some((entry) => entry.includes("task_id 'T-OTHER'")));
    assert.ok(first.violations.some((entry) => entry.includes('review_context_sha256 does not match')));
    assert.ok(first.violations.some((entry) => entry.includes('tree_state_sha256 does not match')));
    assert.ok(first.violations.some((entry) => entry.includes('coverage_ledger.coverage_contract_sha256 does not match')));
    assert.ok(first.violations.some((entry) => entry.includes("Duplicate finding id 'F-001'")));
    assert.ok(first.violations.some((entry) => entry.includes('findings.high[1].evidence must contain')));
    assert.ok(first.violations.some((entry) => entry.includes('residual_risks[0].id must match R-###')));
    assert.ok(first.violations.some((entry) => entry.includes('residual_risks[0].evidence must contain')));
    assert.ok(first.violations.some((entry) => entry.includes(`Expected coverage obligation '${categoryObligation.id}'`)));
    assert.ok(first.violations.some((entry) => entry.includes(`Coverage obligation '${fileObligation.id}' is duplicated`)));
    assert.ok(first.violations.some((entry) => entry.includes("Coverage obligation 'CATEGORY-UNKNOWN' is not part of the current contract")));
    assert.ok(first.violations.some((entry) => entry.includes('generic evidence')));
    assert.ok(first.violations.some((entry) => entry.includes("Coverage ledger references unknown finding 'F-999'")));
    assert.ok(first.violations.some((entry) => entry.includes("Finding 'F-001' is not referenced by any coverage ledger entry")));
});
