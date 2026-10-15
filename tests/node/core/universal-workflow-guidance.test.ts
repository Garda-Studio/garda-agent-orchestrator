import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildDefaultWorkflowConfig } from '../../../src/core/workflow-config';
import { mergeOptionalQualityChecksWithBaseline, normalizeOptionalQualityChecksConfig } from '../../../src/core/optional-quality-checks';
import { TRUST_BOUNDARY_ANALYSIS_RULE_ID, TRUST_BOUNDARY_ANALYSIS_RULE_PROMPT } from '../../../src/core/trust-boundary-analysis';
import { buildFullSuitePerformanceGuidance } from '../../../src/gates/full-suite/full-suite-validation-config';

const HISTORICAL_BUILT_IN_PROMPT = 'For security, authorization, protected-control-plane, recovery, evidence, or artifact-trust changes, provide a compact trust_boundary_matrix. Name every trust boundary and record its authority source, mutable inputs, immutable or integrity-bound evidence, canonical reconstruction, TOCTOU or replay behavior, and targeted negative paths with test evidence. Every negative-path evidence_files entry must use path#exact test name, scenario must equal that declared test name, and the named test callback must contain a direct assertion statement outside conditional control flow or a nested callback. Happy-path evidence alone is not sufficient.';

function trustRule(config: ReturnType<typeof buildDefaultWorkflowConfig>['optional_quality_checks']) {
    const rule = config.rules.find(item => item.id === TRUST_BOUNDARY_ANALYSIS_RULE_ID);
    assert.ok(rule);
    return rule;
}

test('ordinary trust guidance binds source and case evidence without JS callback requirements', () => {
    const defaults = buildDefaultWorkflowConfig();
    const template = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'template/config/workflow-config.json'), 'utf8'));
    const prompt = trustRule(defaults.optional_quality_checks).prompt;
    assert.equal(prompt, TRUST_BOUNDARY_ANALYSIS_RULE_PROMPT);
    assert.equal(trustRule(template.optional_quality_checks).prompt, prompt);
    assert.doesNotMatch(prompt, /named test callback|direct assertion statement|scenario must equal that declared test name/u);
    assert.match(prompt, /source/u);
    assert.match(prompt, /selector/u);
    assert.match(prompt, /execution/u);
});

test('normal load and update replace the exact historical built-in prompt while preserving local choices', () => {
    const defaults = buildDefaultWorkflowConfig().optional_quality_checks;
    const existing = structuredClone(defaults);
    const original = trustRule(existing);
    original.prompt = HISTORICAL_BUILT_IN_PROMPT;
    original.enabled = false;
    original.excluded_scope_categories = ['doc-only'];
    original.included_changed_file_regexes = ['(^|/)security/'];
    const preserved = structuredClone(original);
    for (const result of [normalizeOptionalQualityChecksConfig(existing), mergeOptionalQualityChecksWithBaseline(defaults, existing)]) {
        assert.deepEqual(trustRule(result), {...preserved, prompt: TRUST_BOUNDARY_ANALYSIS_RULE_PROMPT});
        assert.equal(result.enabled, existing.enabled);
        assert.equal(result.review_failure_cadence_interval, existing.review_failure_cadence_interval);
    }
    assert.deepEqual(trustRule(existing), preserved);
});

test('ordinary load and older-baseline update retain a custom trust-boundary prompt and title', () => {
    const defaults = buildDefaultWorkflowConfig().optional_quality_checks;
    for (const baseline of [defaults.baseline_version, '2025-custom-install']) {
        const existing = structuredClone(defaults);
        existing.baseline_version = baseline;
        const original = trustRule(existing);
        original.title = 'Project-specific trust boundary';
        original.prompt = 'Verify our explicit source identities and case selectors against authentic execution.';
        original.enabled = false;
        original.excluded_scope_categories = ['doc-only'];
        original.included_changed_file_regexes = ['(^|/)security/'];
        const preserved = structuredClone(original);
        for (const result of [normalizeOptionalQualityChecksConfig(existing), mergeOptionalQualityChecksWithBaseline(defaults, existing)]) {
            assert.deepEqual(trustRule(result), preserved);
        }
    }
});

test('suite guidance retains the configured command without inventing a package-manager fallback', () => {
    for (const command of ['checks verify all', 'mvn -o test', 'npm test', 'npm run test:sharded']) {
        const guidance = buildFullSuitePerformanceGuidance(command);
        assert.equal(guidance.fallback_command, null);
        assert.equal(guidance.mandatory_boundary, 'mandatory full-suite evidence; not a smoke, fast, or release-smoke substitute');
        assert.equal(guidance.optimized_command, command === 'npm run test:sharded' ? command : null);
    }
});
