import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildFullSuiteValidationEvidence,
    getReviewContextFullSuiteValidationViolations
} from '../../../../src/gates/review-context/review-context-validation-evidence';
import { resolveNextStep } from '../../../../src/gates/next-step';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import {
    TASK_ID, ALL_REVIEW_FLAGS, makeTempRepo, reviewsRoot, writeJson, fileSha256,
    seedStartedTask, writePreflight, seedCompilePass,
    buildReviewContextScopeFixture, seedFullSuiteValidation
} from '../next-step/next-step-full-suite-fixtures';

function seedCurrentCompile(repoRoot: string): void {
    seedCompilePass(repoRoot, TASK_ID, new Date().toISOString());
}

function makeFixture(scopeCategory = 'docs-only') {
    const repoRoot = makeTempRepo();
    const config = buildDefaultWorkflowConfig();
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator/live/config/workflow-config.json');
    writeJson(configPath, {
        ...config,
        full_suite_validation: { ...config.full_suite_validation, enabled: true,
            command: 'npm test', placement: 'after_compile_before_reviews' },
        project_memory_maintenance: { ...config.project_memory_maintenance, enabled: false }
    });
    seedStartedTask(repoRoot, TASK_ID);
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'docs/runbook.md'), '# Runbook\n');
    const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, {
        scopeCategory, changedFiles: scopeCategory === 'docs-only' ? ['docs/runbook.md'] : ['src/app.ts']
    });
    seedCurrentCompile(repoRoot);
    const options = { repoRoot, taskId: TASK_ID, reviewType: 'code', preflightPath,
        preflightSha256: fileSha256(preflightPath) };
    return { options, configPath };
}

function replacePreflight(options: ReturnType<typeof makeFixture>['options'], updates: Record<string, unknown>) {
    const preflight = JSON.parse(fs.readFileSync(options.preflightPath, 'utf8')) as Record<string, unknown>;
    writeJson(options.preflightPath, { ...preflight, ...updates });
    return { ...options, preflightSha256: fileSha256(options.preflightPath) };
}

function assertDocsOnlyReviewerRouting(options: ReturnType<typeof makeFixture>['options']) {
    const evidence = buildFullSuiteValidationEvidence(options);
    assert.equal(evidence?.required_for_review, false);
    assert.deepEqual(getReviewContextFullSuiteValidationViolations({ ...options,
        reviewContext: { full_suite_validation: evidence } }), []);
    writeJson(path.join(reviewsRoot(options.repoRoot), `${TASK_ID}-code-review-context.json`), {
        schema_version: 2, task_id: TASK_ID, review_type: 'code',
        preflight_path: options.preflightPath.replace(/\\/gu, '/'),
        preflight_sha256: options.preflightSha256,
        ...buildReviewContextScopeFixture(options.repoRoot, TASK_ID, 'code'),
        full_suite_validation: evidence
    });
    const after = resolveNextStep({ repoRoot: options.repoRoot, taskId: TASK_ID });
    assert.equal(after.next_gate, 'record-review-routing', after.reason);
    assert.match(after.commands[0]?.command || '', /gate record-review-routing/u);
}

it('allows current compiled docs-only review without an executed suite', () => {
    const { options } = makeFixture();
    const evidence = buildFullSuiteValidationEvidence(options);
    assert.equal(evidence?.required_for_review, false);
    assert.equal(evidence?.available, false);
    assert.equal(evidence?.artifact_freshness, 'not_required_for_review');
    assert.deepEqual(getReviewContextFullSuiteValidationViolations({ ...options,
        reviewContext: { full_suite_validation: evidence } }), []);
});

it('advances docs-only navigator from current context to reviewer routing', () => {
    const { options } = makeFixture();
    const before = resolveNextStep({ repoRoot: options.repoRoot, taskId: TASK_ID });
    assert.equal(before.next_gate, 'build-review-context', before.reason);
    assertDocsOnlyReviewerRouting(options);
});

it('advances compiled docs-only routing despite obsolete optional suite configuration', () => {
    for (const update of [{ enabled: false }, { command: 'obsolete suite' }, { placement: 'before_completion' }]) {
        const { options } = makeFixture();
        seedFullSuiteValidation(options.repoRoot, TASK_ID, 'PASSED');
        const suitePath = path.join(reviewsRoot(options.repoRoot), `${TASK_ID}-full-suite-validation.json`);
        const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8')) as Record<string, unknown>;
        writeJson(suitePath, { ...suite, ...update, cycle_binding: { task_id: 'T-FOREIGN-1' } });
        assertDocsOnlyReviewerRouting(options);
        assert.equal(buildFullSuiteValidationEvidence(options)?.cycle_binding_valid, false);
    }
});

it('advances compiled docs-only routing despite malformed optional suite evidence', () => {
    const { options } = makeFixture();
    fs.writeFileSync(path.join(reviewsRoot(options.repoRoot), `${TASK_ID}-full-suite-validation.json`), '{');
    assertDocsOnlyReviewerRouting(options);
    assert.equal(buildFullSuiteValidationEvidence(options)?.available, false);
    assert.match(buildFullSuiteValidationEvidence(options)?.parse_error || '', /JSON/u);
});

it('keeps obsolete and malformed executable suite evidence blocking', () => {
    for (const update of [{ enabled: false }, { command: 'obsolete suite' }, { placement: 'before_completion' }, null]) {
        const { options } = makeFixture('code');
        seedFullSuiteValidation(options.repoRoot, TASK_ID, 'PASSED');
        const suitePath = path.join(reviewsRoot(options.repoRoot), `${TASK_ID}-full-suite-validation.json`);
        const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8')) as Record<string, unknown>;
        if (update) writeJson(suitePath, { ...suite, ...update });
        else fs.writeFileSync(suitePath, '{');
        assert.equal(buildFullSuiteValidationEvidence(options)?.required_for_review, true);
        assert.match(getReviewContextFullSuiteValidationViolations({ ...options, reviewContext: null })[0] || '',
            /current full-suite (?:enabled flag|command|placement|artifact is missing or unreadable)/u);
        assert.equal(resolveNextStep({ repoRoot: options.repoRoot, taskId: TASK_ID }).next_gate,
            'full-suite-validation');
    }
});

it('accepts distinct compile finalization and PASS event timestamps in the same cycle', () => {
    const { options } = makeFixture();
    const compilePath = path.join(reviewsRoot(options.repoRoot), `${TASK_ID}-compile-gate.json`);
    const compile = JSON.parse(fs.readFileSync(compilePath, 'utf8')) as Record<string, unknown>;
    writeJson(compilePath, { ...compile,
        timestamp_utc: new Date(Date.parse(String(compile.timestamp_utc)) + 1000).toISOString() });
    assert.equal(buildFullSuiteValidationEvidence(options)?.required_for_review, false);
});

it('rejects changed docs-only preflight bytes under an old digest', () => {
    const { options } = makeFixture();
    replacePreflight(options, { notes: 'Changed after capture' });
    assert.equal(buildFullSuiteValidationEvidence(options)?.required_for_review, true);
    assert.match(getReviewContextFullSuiteValidationViolations({ ...options, reviewContext: null })[0] || '',
        /current full-suite artifact is missing/u);
});

it('rejects foreign preflight task identity despite a matching new digest and compile', () => {
    const { options } = makeFixture();
    const foreign = replacePreflight(options, { task_id: 'T-FOREIGN-1' });
    seedCurrentCompile(options.repoRoot);
    assert.equal(buildFullSuiteValidationEvidence(foreign)?.required_for_review, true);
});

it('rejects a fresh preflight digest that is not bound to the compiled cycle', () => {
    const { options } = makeFixture('code');
    const changed = replacePreflight(options, { scope_category: 'docs-only', changed_files: ['docs/runbook.md'] });
    assert.equal(buildFullSuiteValidationEvidence(changed)?.required_for_review, true);
});

it('rejects missing compile evidence instead of inferring docs-only readiness', () => {
    const { options } = makeFixture();
    fs.unlinkSync(path.join(reviewsRoot(options.repoRoot), `${TASK_ID}-compile-gate.json`));
    assert.equal(buildFullSuiteValidationEvidence(options)?.required_for_review, true);
});

it('rejects missing and malformed docs-only preflight artifacts', () => {
    const { options } = makeFixture();
    fs.writeFileSync(options.preflightPath, '{');
    assert.equal(buildFullSuiteValidationEvidence({ ...options,
        preflightSha256: fileSha256(options.preflightPath) })?.required_for_review, true);
    fs.unlinkSync(options.preflightPath);
    assert.equal(buildFullSuiteValidationEvidence(options)?.required_for_review, true);
});

it('rejects off-root preflight identity rather than borrowing another workspace exemption', () => {
    const { options } = makeFixture();
    const other = makeFixture();
    assert.equal(buildFullSuiteValidationEvidence({ ...options,
        preflightPath: other.options.preflightPath,
        preflightSha256: other.options.preflightSha256 })?.required_for_review, true);
});

it('rejects oversized docs-only classification despite a current digest and compile', () => {
    const { options } = makeFixture();
    const oversized = replacePreflight(options, { notes: 'x'.repeat(1024 * 1024) });
    seedCurrentCompile(options.repoRoot);
    assert.equal(buildFullSuiteValidationEvidence(oversized)?.required_for_review, true);
});

it('rejects a hard-linked current docs-only preflight file', () => {
    const { options } = makeFixture();
    fs.linkSync(options.preflightPath, path.join(reviewsRoot(options.repoRoot), 'shared-preflight.json'));
    assert.equal(buildFullSuiteValidationEvidence(options)?.required_for_review, true);
});

it('rejects unknown task and missing or malformed expected preflight digests', () => {
    const { options } = makeFixture();
    assert.equal(buildFullSuiteValidationEvidence({ ...options, taskId: null })?.required_for_review, true);
    assert.equal(buildFullSuiteValidationEvidence({ ...options, preflightSha256: null })?.required_for_review, true);
    assert.equal(buildFullSuiteValidationEvidence({ ...options, preflightSha256: 'untrusted' })?.required_for_review, true);
});

it('preserves suite requirements for execution-triggered and empty docs-only scopes', () => {
    const { options } = makeFixture();
    const required = ['runtime_code_changed', 'test', 'infra', 'performance'].map(trigger => {
        const changed = replacePreflight(options, { triggers: { [trigger]: true } });
        seedCurrentCompile(options.repoRoot);
        return buildFullSuiteValidationEvidence(changed)?.required_for_review;
    });
    assert.deepEqual(required, [true, true, true, true]);
    const empty = replacePreflight(options, { changed_files: [], triggers: {} });
    seedCurrentCompile(options.repoRoot);
    assert.equal(buildFullSuiteValidationEvidence(empty)?.required_for_review, true);
});

it('preserves current code suite status and cycle binding checks', () => {
    const { options } = makeFixture('code');
    assert.equal(buildFullSuiteValidationEvidence(options)?.required_for_review, true);
    seedFullSuiteValidation(options.repoRoot, TASK_ID, 'PASSED');
    const evidence = buildFullSuiteValidationEvidence(options);
    assert.deepEqual(getReviewContextFullSuiteValidationViolations({ ...options,
        reviewContext: { full_suite_validation: evidence } }), []);
    const suitePath = path.join(reviewsRoot(options.repoRoot), `${TASK_ID}-full-suite-validation.json`);
    const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8')) as Record<string, unknown>;
    writeJson(suitePath, { ...suite, cycle_binding: { task_id: 'T-FOREIGN-1' } });
    assert.match(getReviewContextFullSuiteValidationViolations({ ...options,
        reviewContext: { full_suite_validation: evidence } })[0] || '', /cycle binding is not valid/u);
});

it('retains configuration binding for a docs-only review context', () => {
    const { options } = makeFixture();
    const evidence = buildFullSuiteValidationEvidence(options);
    assert.match(getReviewContextFullSuiteValidationViolations({ ...options,
        reviewContext: { full_suite_validation: { ...evidence, enabled: false } } })[0] || '',
    /enabled flag/u);
    assert.match(getReviewContextFullSuiteValidationViolations({ ...options,
        reviewContext: { full_suite_validation: { ...evidence, command: 'skip everything' } } })[0] || '',
    /command/u);
});

it('preserves placement rules for executable test review and completion', () => {
    const { options, configPath } = makeFixture('code');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const suite = config.full_suite_validation as Record<string, unknown>;
    writeJson(configPath, { ...config, full_suite_validation: { ...suite, placement: 'before_test_review' } });
    assert.equal(buildFullSuiteValidationEvidence(options)?.required_for_review, false);
    assert.equal(buildFullSuiteValidationEvidence({ ...options, reviewType: 'test' })?.required_for_review, true);
    writeJson(configPath, { ...config, full_suite_validation: { ...suite, placement: 'before_completion' } });
    assert.equal(buildFullSuiteValidationEvidence({ ...options, reviewType: 'test' })?.required_for_review, false);
});
