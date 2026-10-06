import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    assessTrustBoundaryAnalysisApplicability,
    assessTrustBoundaryMatrix,
    TRUST_BOUNDARY_NEGATIVE_PATH_KINDS
} from '../../../src/core/trust-boundary-analysis';

function buildMatrix(kind: typeof TRUST_BOUNDARY_NEGATIVE_PATH_KINDS[number]) {
    const scenario = `${kind} reviewer evidence is presented`;
    return [{
        boundary_id: 'TB-001',
        boundary: 'Mutable review output to authenticated receipt',
        authority_source: 'Gate-owned reviewer launch and receipt bindings',
        mutable_inputs: ['provider reviewer output'],
        integrity_evidence: ['launch input sha256', 'review context sha256', 'tree state sha256'],
        canonical_reconstruction: 'Rebuild the receipt from the immutable launch input and normalized findings.',
        toctou_replay: 'Reject output that predates delegation start or belongs to an earlier review cycle.',
        negative_paths: [{
            kind,
            scenario,
            expected_behavior: 'Reject the evidence without creating accepted review state.',
            evidence_files: [`tests/${kind}-review-evidence.test.ts#${scenario}`]
        }]
    }];
}

function assessNamedTestSource(source: string, extension = '.ts'): string[] {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-regex-evidence-'));
    try {
        fs.mkdirSync(path.join(repoRoot, 'tests'));
        const evidenceFile = `tests/negative-path.test${extension}`;
        fs.writeFileSync(path.join(repoRoot, evidenceFile), source, 'utf8');
        const matrix = buildMatrix('replaced');
        matrix[0].negative_paths[0].evidence_files = [
            `${evidenceFile}#replaced reviewer evidence is presented`
        ];
        return assessTrustBoundaryMatrix(matrix, { repoRoot }).violations;
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

function namedTestBody(body: string): string {
    return `test('replaced reviewer evidence is presented', () => {\n${body}\n});\n`;
}

describe('trust-boundary analysis contract', () => {
    it('recognizes direct assertions after regex quotes, classes, escaped delimiters and callback cleanup', () => {
        const bodies = [
            String.raw`const match = html.match(/const actionToken = "([^"]+)";/u);
assert.equal(match[1], expected);`,
            String.raw`const pattern = /['"{}()[\]\/]/u;
assert.ok(pattern.test(value));`,
            String.raw`try { html.match(/const actionToken = "([^"]+)";/u); }
finally { stop(); }
assert.equal(status, 403);`,
            String.raw`const pattern = /escaped\/delimiter\\and"quote/gu;
assert.ok(pattern.test(value));`,
            String.raw`const options = { pattern: /["'}]/u };
assert.ok(options.pattern.test(value));`,
            String.raw`const callback = (pattern = /["'}]/u) => pattern.test(value);
assert.ok(callback());`,
            String.raw`for (const value of /["'}]/u.exec(text) || []) { work(value); }
assert.equal(status, expected);`,
            String.raw`for (const λ of /["'}]/u.exec(text) || []) { work(λ); }
assert.equal(status, expected);`
        ];
        assert.deepEqual(bodies.map((body) => assessNamedTestSource(namedTestBody(body))), bodies.map(() => []));
    });

    it('distinguishes division and division assignment from a regex operand before direct assertions', () => {
        const bodies = [
            'const result = count / 2 / divisor;\nassert.equal(result, expected);',
            'count /= 2;\nassert.equal(count, expected);',
            'const result = getCount() / values[0];\nassert.equal(result, expected);',
            'const result = object.if(value) / divisor / 2;\nassert.equal(result, expected);',
            'const result = (count + 1) / divisor;\nassert.equal(result, expected);',
            'const result = count++ / divisor;\nassert.equal(result, expected);',
            'const result = count! / 2;\nassert.equal(result, expected);',
            'const result = fn<number> / divisor;\nassert.equal(result, expected);',
            'const result = fn<Array<number>> / divisor;\nassert.equal(result, expected);',
            'const of = 8; const result = of / 2;\nassert.equal(result, expected);',
            'const λ = 8; const result = λ / 2;\nassert.equal(result, expected);',
            'const \u{10400} = 8; const result = \u{10400} / 2;\nassert.equal(result, expected);',
            String.raw`const result = count / /["'}]/u.test(value);
assert.equal(result, expected);`,
            String.raw`const result = count !== /["'}]/u.test(value);
assert.equal(result, expected);`,
            String.raw`const result = !/["'}]/u.test(value);
assert.equal(result, expected);`,
            String.raw`const result = count > /["'}]/u.test(value);
assert.equal(result, expected);`
        ];
        assert.deepEqual(bodies.map((body) => assessNamedTestSource(namedTestBody(body))), bodies.map(() => []));
    });

    it('rejects forged regex assertion text and conditional or nested-only assertions after regex literals', () => {
        const bodies = [
            String.raw`const pattern = /assert.equal\(value, expected\);/u;`,
            String.raw`const pattern = /["'}]/u; /* assert.equal(value, expected); */
const note = "assert.equal(value, expected);";`,
            String.raw`if (/["'}]/u.test(value)) { assert.equal(value, expected); }`,
            String.raw`while (/["'}]/u.test(value)) { assert.equal(value, expected); }`,
            String.raw`const pattern = /["'}]/u;
const callback = () => { assert.equal(value, expected); };`,
            String.raw`const pattern = /["'}]/u;
values.forEach(() => { assert.equal(value, expected); });`,
            String.raw`const pattern = /["'}]/u;
false && assert.equal(value, expected);`
        ];
        assert.deepEqual(bodies.map((body) => assessNamedTestSource(namedTestBody(body)).length > 0), bodies.map(() => true));
    });

    it('rejects forged test names inside regex literals and preserves real declarations after regex literals', () => {
        const realTest = namedTestBody('assert.equal(value, expected);');
        const prefix = String.raw`const pattern = /["'}]/u;` + '\n';
        assert.deepEqual(assessNamedTestSource(prefix + realTest), []);
        assert.ok(assessNamedTestSource(
            String.raw`const pattern = /test\('replaced reviewer evidence is presented', \(\) => \{ assert.equal\(1, 1\); \}\);/u;`
        ).length > 0);
        assert.ok(assessNamedTestSource(
            'if (false) {\n' + prefix + realTest + '}\n'
        ).length > 0);
    });

    it('rejects nested-only object and class method assertions after regex literals', () => {
        const assertion = String.raw`const pattern = /["'}]/u; assert.equal(1, 1);`;
        const bodies = [
            `const never = { check() { ${assertion} } };`,
            `const never = { async check() { ${assertion} } };`,
            `const never = { *check() { ${assertion} } };`,
            `const never = { [name]() { ${assertion} } };`,
            `const never = { get value() { ${assertion} return 1; } };`,
            `const never = { set value(input) { ${assertion} } };`,
            `class Never { check() { ${assertion} } }`,
            `class Never { constructor() { ${assertion} } }`,
            `class Never { get value() { ${assertion} return 1; } }`,
            `class Never { static { ${assertion} } }`
        ];
        for (const body of bodies) {
            assert.ok(assessNamedTestSource(namedTestBody(body)).length > 0, body);
            assert.deepEqual(assessNamedTestSource(namedTestBody(body + '\nassert.equal(value, expected);')), [], body);
        }
        assert.ok(assessNamedTestSource(
            `const never = { check() { ${assertion}\n${namedTestBody('assert.equal(value, expected);')} } };`
        ).length > 0);
    });

    it('fails closed for malformed regex literals even when direct assertion text is present', () => {
        const bodies = [
            'const pattern = /unterminated;\nassert.equal(value, expected);',
            'const pattern = /[unterminated/;\nassert.equal(value, expected);',
            String.raw`const pattern = /escaped\/;
assert.equal(value, expected);`,
            'const pattern = /(/u;\nassert.equal(value, expected);',
            'const pattern = /value/uu;\nassert.equal(value, expected);',
            'const pattern = /value/z;\nassert.equal(value, expected);',
            'const pattern = /value/uv;\nassert.equal(value, expected);',
            'const pattern = /value/λ;\nassert.equal(value, expected);',
            'const pattern = /value/uλ;\nassert.equal(value, expected);',
            'const pattern = /value/\u0301;\nassert.equal(value, expected);',
            'const pattern = /value/\u{10400};\nassert.equal(value, expected);',
            String.raw`const pattern = /value/\u0067;
assert.equal(value, expected);`,
            'assert.equal(value, expected);\nconst pattern = /unterminated;',
            'const pattern = /value\u2028other/u;\nassert.equal(value, expected);'
        ];
        assert.deepEqual(bodies.map((body) => assessNamedTestSource(namedTestBody(body)).length > 0), bodies.map(() => true));
    });

    it('rejects contextual identifier division that could forge conditional assertion evidence', () => {
        const bodies = [
            'const of = 8; of / 2; if (false) { /(?:value)/;\nassert.equal(1, 1);\n}',
            'const await = 8; await / 2; if (false) { /(?:value)/;\nassert.equal(1, 1);\n}',
            'const yield = 8; yield / 2; if (false) { /(?:value)/;\nassert.equal(1, 1);\n}',
            'const λ = 8; λ / 2; if (false) { /(?:value)/;\nassert.equal(1, 1);\n}',
            'const \u{10400} = 8; \u{10400} / 2; if (false) { /(?:value)/;\nassert.equal(1, 1);\n}'
        ];
        assert.deepEqual(bodies.map((body) => assessNamedTestSource(namedTestBody(body)).length > 0), bodies.map(() => true));
    });

    it('distinguishes regex and division after closing braces before direct assertions', () => {
        const bodies = [
            'const result = { value: 1 } / divisor;\nassert.equal(result, expected);',
            String.raw`if (false) {} /["'}]/u.test(value);
assert.equal(value, expected);`
        ];
        assert.deepEqual(bodies.map((body) => assessNamedTestSource(namedTestBody(body))), bodies.map(() => []));
    });

    it('rejects generic-instantiation division that could hide conditional assertions', () => {
        const bodies = [
            'const result = fn<number> / 2; if (false) { /(?:value)/;\nassert.equal(1, 1);\n}',
            'const result = fn<Array<number>> / 2; if (false) { /(?:value)/;\nassert.equal(1, 1);\n}'
        ];
        assert.deepEqual(bodies.map((body) => assessNamedTestSource(namedTestBody(body)).length > 0), bodies.map(() => true));
    });

    it('validates regex syntax in executable template substitutions without accepting embedded assertions', () => {
        const validBodies = [
            'const value = `${/value/u.test(input)}`;\nassert.equal(value, expected);',
            'const value = tag`${/value/u.test(input)}`;\nassert.equal(value, expected);',
            'const value = `${`${/value/u.test(input)}`}`;\nassert.equal(value, expected);',
            'const value = `/(/u`;\nassert.equal(value, expected);'
        ];
        assert.deepEqual(validBodies.map((body) => assessNamedTestSource(namedTestBody(body))), validBodies.map(() => []));
        const invalidBodies = [
            'const value = `${/(/u}`;\nassert.equal(value, expected);',
            'assert.equal(value, expected);\nconst value = `${/(/u}`;',
            'const value = tag`${/(/u}`;\nassert.equal(value, expected);',
            'const value = `${`${/value/\u03bb}`}`;\nassert.equal(value, expected);',
            'const value = `${assert.equal(value, expected)}`;',
            'const value = `${value;\nassert.equal(value, expected);'
        ];
        assert.deepEqual(invalidBodies.map((body) => assessNamedTestSource(namedTestBody(body)).length > 0), invalidBodies.map(() => true));
    });

    it('preserves supported source kinds and ignores assertion-looking JSX text', () => {
        const source = namedTestBody('const pattern = /value/u;\nassert.ok(pattern.test(value));');
        for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) {
            assert.deepEqual(assessNamedTestSource(source, extension), [], extension);
        }
        assert.deepEqual(assessNamedTestSource(namedTestBody(
            'const value = <div>{/value/u.test(input)}</div>;\nassert.equal(value, expected);'
        ), '.tsx'), []);
        assert.ok(assessNamedTestSource(namedTestBody(
            'const value = <div>;assert.equal(value, expected);</div>;'
        ), '.tsx').length > 0);
    });

    it('uses bundled parser for regex evidence in a detached runtime without development dependencies', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-detached-evidence-'));
        try {
            const requireFromTest = createRequire(__filename);
            const compiledCore = path.dirname(requireFromTest.resolve('../../../src/core/trust-boundary-analysis'));
            for (const filename of ['trust-boundary-analysis.js', 'test-evidence-lexing.js', 'vendor-typescript.js']) {
                fs.copyFileSync(path.join(compiledCore, filename), path.join(repoRoot, filename));
            }
            fs.mkdirSync(path.join(repoRoot, 'tests'));
            fs.writeFileSync(path.join(repoRoot, 'tests', 'replaced-review-evidence.test.ts'), namedTestBody(
                'const result = fn<number> / divisor;\nassert.equal(result, expected);'
            ));
            const detached = requireFromTest(path.join(repoRoot, 'trust-boundary-analysis.js')) as {
                assessTrustBoundaryMatrix: typeof assessTrustBoundaryMatrix;
            };
            assert.deepEqual(detached.assessTrustBoundaryMatrix(buildMatrix('replaced'), { repoRoot }).violations, []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts targeted forged, replaced, missing, foreign, and stale negative paths', () => {
        for (const kind of TRUST_BOUNDARY_NEGATIVE_PATH_KINDS.filter((entry) => entry !== 'other')) {
            const assessment = assessTrustBoundaryMatrix(buildMatrix(kind));
            assert.deepEqual(assessment.violations, [], `Expected '${kind}' matrix to be complete.`);
            assert.equal(assessment.matrix[0].negative_paths[0].kind, kind);
            assert.match(assessment.matrix_sha256, /^[a-f0-9]{64}$/u);
        }
    });

    it('rejects incomplete happy-path-only analysis', () => {
        const assessment = assessTrustBoundaryMatrix([{
            boundary_id: 'TB-001',
            boundary: 'Review output receipt',
            authority_source: 'Gate-owned launch',
            mutable_inputs: ['review output'],
            integrity_evidence: ['receipt hash'],
            canonical_reconstruction: 'Rebuild from launch input.',
            toctou_replay: 'Reject stale cycles.',
            negative_paths: []
        }]);

        assert.ok(assessment.violations.some((violation) => violation.includes('negative_paths')));

        const happyPathOnly = buildMatrix('other');
        happyPathOnly[0].negative_paths[0] = {
            kind: 'other',
            scenario: 'accepts valid reviewer evidence',
            expected_behavior: 'Accept the evidence and continue.',
            evidence_files: ['tests/other-review-evidence.test.ts#accepts valid reviewer evidence']
        };
        const happyPathAssessment = assessTrustBoundaryMatrix(happyPathOnly);
        assert.ok(happyPathAssessment.violations.some((violation) => (
            violation.includes("scenario for kind 'other'")
        )));
        assert.ok(happyPathAssessment.violations.some((violation) => (
            violation.includes('fail-closed or recovery action')
        )));
    });

    it('requires existing in-repository test evidence when a repository root is supplied', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-trust-boundary-evidence-'));
        try {
            const testPath = path.join(repoRoot, 'tests', 'negative-path.test.ts');
            fs.mkdirSync(path.dirname(testPath), { recursive: true });
            fs.writeFileSync(
                testPath,
                "test('replaced reviewer evidence is presented', () => { assert.equal(1, 1); });\n",
                'utf8'
            );
            const currentMatrix = buildMatrix('replaced');
            currentMatrix[0].negative_paths[0].evidence_files = [
                'tests/negative-path.test.ts#replaced reviewer evidence is presented'
            ];
            assert.deepEqual(assessTrustBoundaryMatrix(currentMatrix, { repoRoot }).violations, []);

            fs.writeFileSync(
                testPath,
                "describe('review evidence', () => {\n"
                    + "    test('replaced reviewer evidence is presented', () => { assert.equal(1, 1); });\n"
                    + "});\n",
                'utf8'
            );
            assert.deepEqual(assessTrustBoundaryMatrix(currentMatrix, { repoRoot }).violations, []);

            for (const evidenceFile of ['tests/missing.test.ts', 'src/app.ts', '../outside.test.ts']) {
                const invalidMatrix = buildMatrix('replaced');
                invalidMatrix[0].negative_paths[0].evidence_files = [
                    `${evidenceFile}#replaced reviewer evidence is presented`
                ];
                assert.ok(
                    assessTrustBoundaryMatrix(invalidMatrix, { repoRoot }).violations.some((violation) => (
                        violation.includes('test file')
                    )),
                    evidenceFile
                );
            }

            for (const [fixtureName, noOpSource] of [
                ['empty', "test('replaced reviewer evidence is presented', () => {});\n"],
                [
                    'no-assertion',
                    "test('replaced reviewer evidence is presented', () => { const observed = 'replaced'; });\n"
                ],
                [
                    'inert-assertion',
                    "test('replaced reviewer evidence is presented', () => { /* assert.equal(1, 1); */ const note = 'expect(value)'; });\n"
                ],
                [
                    'unreachable-assertion',
                    "test('replaced reviewer evidence is presented', () => { if (false) { assert.equal(1, 1); } });\n"
                ],
                [
                    'short-circuited-assertion',
                    "test('replaced reviewer evidence is presented', () => { false && assert.equal(1, 1); });\n"
                ],
                [
                    'nested-assertion',
                    "test('replaced reviewer evidence is presented', () => { const neverCalled = () => { assert.equal(1, 1); }; });\n"
                ],
                [
                    'nested-callback-assertion',
                    "test('replaced reviewer evidence is presented', () => { [].forEach(() => { assert.equal(1, 1); }); });\n"
                ],
                [
                    'conditional-test-declaration',
                    "if (false) {\n    test('replaced reviewer evidence is presented', () => { assert.equal(1, 1); });\n}\n"
                ],
                [
                    'skipped-suite-test-declaration',
                    "describe.skip('review evidence', () => {\n"
                        + "    test('replaced reviewer evidence is presented', () => { assert.equal(1, 1); });\n"
                        + "});\n"
                ]
            ] as const) {
                const noOpTestPath = path.join(repoRoot, 'tests', `${fixtureName}.test.ts`);
                fs.writeFileSync(noOpTestPath, noOpSource, 'utf8');
                const noOpMatrix = buildMatrix('replaced');
                noOpMatrix[0].negative_paths[0].evidence_files = [
                    `tests/${fixtureName}.test.ts#replaced reviewer evidence is presented`
                ];
                assert.ok(
                    assessTrustBoundaryMatrix(noOpMatrix, { repoRoot }).violations.some((violation) => (
                        violation.includes('direct assertion statement')
                    )),
                    fixtureName
                );
            }

            const unrelatedTestPath = path.join(repoRoot, 'tests', 'unrelated.test.ts');
            fs.writeFileSync(unrelatedTestPath, "test('covers unrelated behavior', () => {});\n", 'utf8');
            const unrelatedMatrix = buildMatrix('replaced');
            unrelatedMatrix[0].negative_paths[0].evidence_files = [
                'tests/unrelated.test.ts#replaced reviewer evidence is presented'
            ];
            assert.ok(assessTrustBoundaryMatrix(unrelatedMatrix, { repoRoot }).violations.some((violation) => (
                violation.includes('exact declared it/test case name')
            )));

            for (const modifier of ['skip', 'todo']) {
                const nonExecutingTestPath = path.join(repoRoot, 'tests', `${modifier}.test.ts`);
                fs.writeFileSync(
                    nonExecutingTestPath,
                    `test.${modifier}('replaced reviewer evidence is presented', () => {});\n`,
                    'utf8'
                );
                const nonExecutingMatrix = buildMatrix('replaced');
                nonExecutingMatrix[0].negative_paths[0].evidence_files = [
                    `tests/${modifier}.test.ts#replaced reviewer evidence is presented`
                ];
                assert.ok(
                    assessTrustBoundaryMatrix(nonExecutingMatrix, { repoRoot }).violations.some((violation) => (
                        violation.includes('exact declared it/test case name')
                    )),
                    modifier
                );
            }

            for (const [fixtureName, inertSource] of [
                ['comment', "// test('replaced reviewer evidence is presented', () => {});\n"],
                ['string', "const inert = \"test('replaced reviewer evidence is presented', () => {})\";\n"],
                ['template', "const inert = `\ntest('replaced reviewer evidence is presented', () => {});\n`;\n"]
            ] as const) {
                const inertTestPath = path.join(repoRoot, 'tests', `${fixtureName}.test.ts`);
                fs.writeFileSync(inertTestPath, inertSource, 'utf8');
                const inertMatrix = buildMatrix('replaced');
                inertMatrix[0].negative_paths[0].evidence_files = [
                    `tests/${fixtureName}.test.ts#replaced reviewer evidence is presented`
                ];
                assert.ok(
                    assessTrustBoundaryMatrix(inertMatrix, { repoRoot }).violations.some((violation) => (
                        violation.includes('exact declared it/test case name')
                    )),
                    fixtureName
                );
            }
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('requires analysis for security triggers and sensitive control-plane paths only', () => {
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: { security: true },
            changed_files: ['src/app.ts']
        }).required, true);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['src/gates/review/review-findings-schema.ts']
        }).required, true);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['garda-agent-orchestrator/live/config/workflow-config.json']
        }).required, true);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['garda-agent-orchestrator/template/config/workflow-config.json']
        }).required, true);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['template/config/workflow-config.json']
        }).required, true);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['src/ui/review-panel.ts']
        }).required, false);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['src/domain/catalog.ts']
        }).required, false);
    });
});
