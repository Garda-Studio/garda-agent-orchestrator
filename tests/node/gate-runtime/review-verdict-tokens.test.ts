import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildReviewVerdictTokenSet,
    extractReviewVerdictSectionTokenMatch,
    extractReviewVerdictToken,
    extractReviewVerdictTokenMatch
} from '../../../src/gate-runtime/review/review-verdict-tokens';
import { resolveReviewFindingsArtifactVerdictToken } from '../../../src/gates/review/review-findings-artifact-verdict';
import { buildReviewCoverageContract } from '../../../src/gates/review/review-coverage-ledger';
import { buildReviewRemediationReviewContract } from '../../../src/gates/review-remediation/review-remediation-review-contract';

const PASS_TOKEN = 'REVIEW PASSED';
const FAIL_TOKEN = 'REVIEW FAILED';
const CODE_TOKENS = buildReviewVerdictTokenSet('code', PASS_TOKEN, FAIL_TOKEN);
const JSON_COVERAGE_CONTRACT = buildReviewCoverageContract({
    reviewType: 'code',
    changedFiles: ['src/example.ts'],
    categoryIds: ['schema']
});
const JSON_EXECUTION_CONTRACT = buildReviewRemediationReviewContract({
    taskId: 'T-213-json-fixture',
    reviewType: 'code',
    preflightSha256: 'e'.repeat(64),
    fullReviewScope: ['src/example.ts']
});

const ambiguousReviews = [
    ['PASS then FAIL in one verdict section', '## Verdict\nREVIEW PASSED\nREVIEW FAILED'],
    ['FAIL then PASS in one verdict section', '## Verdict\nREVIEW FAILED\nREVIEW PASSED'],
    ['conflicting code aliases', '## Verdict\nCODE REVIEW PASSED\nREVIEW FAILED'],
    ['conflicting repeated verdict sections', '## Verdict\nREVIEW PASSED\n## Verdict\nREVIEW FAILED'],
    ['conflicting standalone tokens', 'REVIEW PASSED\nREVIEW FAILED'],
    ['conflicting standalone tokens in reverse order', 'REVIEW FAILED\nREVIEW PASSED'],
    ['standalone FAIL conflicting with explicit PASS', 'REVIEW FAILED\n## Verdict\nREVIEW PASSED'],
    ['standalone PASS conflicting with explicit FAIL', 'REVIEW PASSED\n## Verdict\nREVIEW FAILED'],
    ['empty explicit verdict with an unrelated PASS', '## Verdict\n## Notes\nREVIEW PASSED'],
    ['invalid explicit verdict with an earlier PASS', 'REVIEW PASSED\n## Verdict\nAPPROVED'],
    ['conflicting later verdict after an empty section', '## Verdict\n## Verdict\nREVIEW PASSED\nREVIEW FAILED'],
    ['contradictory verdict after singular example prose', '## Verdict\nREVIEW PASSED\nExample cases revealed a blocker.\nREVIEW FAILED'],
    ['contradictory verdict after allowed-token prose', '## Verdict\nREVIEW PASSED\nAllowed values include tokens in prose.\nREVIEW FAILED'],
    ['contradictory verdict after accepted-token prose', '## Verdict\nREVIEW PASSED\nAccepted tokens were checked for ambiguity.\nREVIEW FAILED'],
    ['contradictory verdict after a longer inline code span', '## Verdict\nREVIEW PASSED\n````note````\nREVIEW FAILED'],
    ['contradictory verdict after invalid backtick fence info', '## Verdict\nREVIEW PASSED\n```markdown `note`\nREVIEW FAILED'],
    ['contradictory verdict after an indented tilde marker', '## Verdict\nREVIEW PASSED\n\n    ~~~\nREVIEW FAILED'],
    ['contradictory verdict after a tab-indented fence marker', '## Verdict\nREVIEW PASSED\n\n\t```\nREVIEW FAILED'],
    ['contradictory verdict after an indented example heading', '## Verdict\nREVIEW PASSED\n\n    ## Examples\nREVIEW FAILED'],
    ['contradictory verdict after an indented example label', '## Verdict\nREVIEW PASSED\n\n    Examples:\nREVIEW FAILED'],
    ['contradictory verdict after an indented allowed-token label', '## Verdict\nREVIEW PASSED\n\n    Allowed PASS tokens:\nREVIEW FAILED'],
    ['contradictory verdict after an invalid seven-hash example heading', '## Verdict\nREVIEW PASSED\n####### Examples\nREVIEW FAILED'],
    ['matching verdict after an empty first section', '## Verdict\n## Verdict\nREVIEW PASSED'],
    ['matching verdict after an invalid first section', '## Verdict\nAPPROVED\n## Verdict\nREVIEW PASSED'],
    ['empty final section after a valid verdict', '## Verdict\nREVIEW PASSED\n## Verdict'],
    ['invalid final section after a valid verdict', '## Verdict\nREVIEW PASSED\n## Verdict\nAPPROVED'],
    ['empty middle section between matching verdicts', '## Verdict\nREVIEW PASSED\n## Verdict\n## Verdict\nCODE REVIEW PASSED'],
    ['contradictory verdict after leaving a list fence', '## Verdict\nREVIEW PASSED\n- ```\nREVIEW FAILED'],
    ['contradictory verdict after leaving a list label', '## Verdict\nREVIEW PASSED\n- Examples:\nREVIEW FAILED'],
    ['contradictory verdict after leaving a list heading', '## Verdict\nREVIEW PASSED\n- ## Examples\nREVIEW FAILED'],
    ['empty list verdict with unrelated external PASS', '- ## Verdict\nREVIEW PASSED'],
    ['empty repeated list verdict with unrelated external PASS', '## Verdict\nREVIEW PASSED\n- ## Verdict\nAPPROVED\nREVIEW PASSED']
] as const;

for (const [label, content] of ambiguousReviews) {
    test(`legacy verdict extraction rejects ${label}`, () => {
        assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
        assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
        assert.equal(extractReviewVerdictToken(content, PASS_TOKEN, FAIL_TOKEN, 'code'), null);
    });
}

const exampleOnlyReviews = [
    ['backtick fenced verdict', '```markdown\n## Verdict\nREVIEW PASSED\n```'],
    ['tilde fenced verdict', '~~~markdown\n## Verdict\nREVIEW PASSED\n~~~'],
    ['fenced tokens inside an explicit verdict', '## Verdict\n```\nREVIEW PASSED\n```'],
    ['unclosed fenced verdict', '```markdown\n## Verdict\nREVIEW PASSED'],
    ['short closing fence', '````markdown\n```\n## Verdict\nREVIEW PASSED'],
    ['allowed token heading', '## Allowed tokens\nREVIEW PASSED'],
    ['accepted PASS token heading', '## Accepted PASS tokens\nCODE REVIEW PASSED'],
    ['allowed token label', 'Allowed tokens:\nREVIEW PASSED'],
    ['bold allowed token label', '**Allowed PASS tokens:**\nREVIEW PASSED'],
    ['accepted token label with inline values', "Accepted PASS tokens: 'REVIEW PASSED'; accepted FAIL tokens: 'REVIEW FAILED'.\nREVIEW PASSED"],
    ['example label', 'Example PASS line:\nREVIEW PASSED'],
    ['descriptive example heading', '## Examples of supported verdicts\nREVIEW PASSED'],
    ['tilde fence with backticks in its info', '~~~markdown `note`\nREVIEW PASSED\n~~~'],
    ['nested example verdict', '## Examples\n### Verdict\nREVIEW PASSED'],
    ['quoted verdict', '> ## Verdict\n> REVIEW PASSED'],
    ['nested list label in a root example section', '## Examples\n- Examples:\nREVIEW PASSED'],
    ['nested list heading in a root example section', '## Examples\n- ### Notes\nREVIEW PASSED'],
    ['nested list verdict in a root example section', '## Examples\n- ## Verdict\n  REVIEW PASSED'],
    ['nested list verdict after a root example label', 'Examples:\n- ## Verdict\n  REVIEW PASSED'],
    ['nested list verdict after a root allowed-token label', 'Allowed tokens:\n- ## Verdict\n  REVIEW PASSED']
] as const;

for (const [label, content] of exampleOnlyReviews) {
    test(`legacy verdict extraction ignores ${label}`, () => {
        assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
        assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
    });
}

for (const marker of ['-', '*', '+']) {
    for (const fence of ['```', '~~~']) {
        test(`legacy verdict extraction rejects a literal ${marker} closer inside a ${fence} example fence`, () => {
            const content = `${fence}markdown\n${marker} ${fence}\n## Verdict\nREVIEW PASSED\n${fence}`;
            assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
            assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
        });
    }
    for (const structure of ['```', '~~~', 'Examples:', '## Examples']) {
        test(`legacy extraction rejects excessive indentation after ${marker} before ${structure}`, () => {
            const content = `## Verdict\nREVIEW PASSED\n${marker}     ${structure}\nREVIEW FAILED`;
            assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
            assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
        });
    }
}

for (const parentMarker of ['-', '*', '+']) {
    for (const childMarker of ['-', '*', '+']) {
        for (const parentExample of ['Examples:', '## Examples']) {
            test(`legacy extraction rejects nested ${childMarker} verdict authority in ${parentMarker} ${parentExample}`, () => {
                const content = `${parentMarker} ${parentExample}\n  ${childMarker} ## Verdict\n    REVIEW PASSED`;
                assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
                assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
            });
        }
    }
}

const supportedReviews = [
    ['canonical PASS', '## Verdict\nREVIEW PASSED', PASS_TOKEN, true],
    ['canonical FAIL', '## Verdict\nREVIEW FAILED', FAIL_TOKEN, true],
    ['code PASS alias', '## Verdict\nCODE REVIEW PASSED', PASS_TOKEN, true],
    ['code FAIL alias', '## Verdict\nCODE REVIEW FAILED', FAIL_TOKEN, true],
    ['bullet and inline code', '## Verdict\n- `REVIEW PASSED`', PASS_TOKEN, true],
    ['matching aliases', '## Verdict\nCODE REVIEW PASSED\nREVIEW PASSED', PASS_TOKEN, true],
    ['matching repeated sections', '## Verdict\nREVIEW PASSED\n## Verdict\nCODE REVIEW PASSED', PASS_TOKEN, true],
    ['standalone PASS alias', '# Review\nCODE REVIEW PASSED', PASS_TOKEN, false],
    ['standalone FAIL', '# Review\nREVIEW FAILED', FAIL_TOKEN, false],
    ['matching standalone aliases', 'CODE REVIEW FAILED\nREVIEW FAILED', FAIL_TOKEN, false],
    ['line ending normalization', '## vErDiCt\r\n+ `CODE REVIEW PASSED`\r', PASS_TOKEN, true],
    ['examples before a real verdict', '## Examples\n### Verdict\nREVIEW FAILED\n## Verdict\nREVIEW PASSED', PASS_TOKEN, true],
    ['allowed tokens before a real verdict', 'Allowed tokens:\nREVIEW FAILED\n## Verdict\nREVIEW PASSED', PASS_TOKEN, true],
    ['fenced example before a real verdict', '```markdown\n## Verdict\nREVIEW FAILED\n```\n## Verdict\nREVIEW PASSED', PASS_TOKEN, true],
    ['fenced example before standalone FAIL', '~~~\nREVIEW PASSED\n~~~\nREVIEW FAILED', FAIL_TOKEN, false],
    ['longer closing fence', '```markdown\nREVIEW FAILED\n````\n## Verdict\nREVIEW PASSED', PASS_TOKEN, true],
    ['example prose before a real verdict', '## Verdict\nExamples revealed no blockers.\nREVIEW PASSED', PASS_TOKEN, true],
    ['allowed-token prose before a real verdict', '## Verdict\nAllowed values include tokens in prose.\nREVIEW PASSED', PASS_TOKEN, true],
    ['accepted-token prose before a real verdict', '## Verdict\nAccepted tokens were checked for ambiguity.\nREVIEW PASSED', PASS_TOKEN, true],
    ['inline code span before a real verdict', '## Verdict\n```note```\nREVIEW PASSED', PASS_TOKEN, true],
    ['inline code span before standalone FAIL', '```note```\nREVIEW FAILED', FAIL_TOKEN, false],
    ['three-space-indented verdict heading', '   ## Verdict\nREVIEW PASSED', PASS_TOKEN, true],
    ['three-space-indented example fence', '## Verdict\nREVIEW PASSED\n   ```markdown\nREVIEW FAILED\n   ```', PASS_TOKEN, true],
    ['three-space-indented example label', '## Verdict\nREVIEW PASSED\n   Examples:\nREVIEW FAILED', PASS_TOKEN, true],
    ['indented marker inside a genuine fence', '## Verdict\nREVIEW PASSED\n```markdown\n    ```\nREVIEW FAILED\n```', PASS_TOKEN, true],
    ['literal bullet closer inside a genuine fence', '## Verdict\nREVIEW PASSED\n```markdown\n- ```\nREVIEW FAILED\n```', PASS_TOKEN, true],
    ['genuine list fence before a real verdict', '## Verdict\n- ```\n  REVIEW FAILED\n  ```\nREVIEW PASSED', PASS_TOKEN, true],
    ['genuine list label before a real verdict', '## Verdict\n- Examples:\n  REVIEW FAILED\nREVIEW PASSED', PASS_TOKEN, true],
    ['genuine list heading before a real verdict', '## Verdict\n- ## Examples\n  REVIEW FAILED\nREVIEW PASSED', PASS_TOKEN, true],
    ['four-space list separator with a genuine fence', '## Verdict\n-    ```\n     REVIEW FAILED\n     ```\nREVIEW PASSED', PASS_TOKEN, true],
    ['tab list separator with a genuine fence', '## Verdict\n-\t```\n    REVIEW FAILED\n    ```\nREVIEW PASSED', PASS_TOKEN, true],
    ['genuine list verdict with its own token', '- ## Verdict\n  REVIEW PASSED', PASS_TOKEN, true],
    ['nested list examples before a real verdict', '## Examples\n- Examples:\n  REVIEW FAILED\n## Verdict\nREVIEW PASSED', PASS_TOKEN, true],
    ['child verdict in a list label before a real verdict', '- Examples:\n  - ## Verdict\n    REVIEW FAILED\n## Verdict\nREVIEW PASSED', PASS_TOKEN, true],
    ['child verdict in a list heading before a real verdict', '- ## Examples\n  - ## Verdict\n    REVIEW FAILED\n## Verdict\nREVIEW PASSED', PASS_TOKEN, true],
    ['peer verdict after a list example label', '- Examples:\n  ## Verdict\n  REVIEW PASSED', PASS_TOKEN, true],
    ['peer verdict after a list example heading', '- ## Examples\n  ## Verdict\n  REVIEW PASSED', PASS_TOKEN, true]
] as const;

for (const [label, content, expectedToken, hasSection] of supportedReviews) {
    test(`legacy verdict extraction preserves ${label}`, () => {
        const match = extractReviewVerdictTokenMatch(content, CODE_TOKENS);
        assert.equal(match?.canonicalToken, expectedToken);
        assert.equal(match?.outcome, expectedToken === PASS_TOKEN ? 'pass' : 'fail');
        assert.equal(
            extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS)?.canonicalToken ?? null,
            hasSection ? expectedToken : null
        );
    });
}

test('legacy verdict extraction rejects generic aliases and conflicting typed verdicts', () => {
    const tokens = buildReviewVerdictTokenSet('security', 'SECURITY REVIEW PASSED', 'SECURITY REVIEW FAILED');
    assert.equal(extractReviewVerdictTokenMatch('## Verdict\nSECURITY REVIEW PASSED', tokens)?.outcome, 'pass');
    assert.equal(extractReviewVerdictTokenMatch('## Verdict\nREVIEW PASSED', tokens), null);
    assert.equal(extractReviewVerdictTokenMatch('## Verdict\nSECURITY REVIEW PASSED\nSECURITY REVIEW FAILED', tokens), null);
});

test('legacy verdict extraction keeps embedded prose and absent tokens non-authoritative', () => {
    for (const content of [null, '', 'The verdict is REVIEW PASSED.', '## Verdict\nreview passed']) {
        assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
        assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
    }
});

test('legacy section extractor rejects contradictory verdict outcomes', () => {
    const content = '## Verdict\nREVIEW PASSED\nREVIEW FAILED';
    assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
    assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
});

test('legacy extraction rejects nested verdict authority inside a list example', () => {
    const content = '- Examples:\n  - ## Verdict\n    REVIEW PASSED';
    assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
    assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
});

test('legacy fallback extractor rejects standalone allowed-token examples', () => {
    const content = 'Allowed PASS tokens:\nREVIEW PASSED';
    assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
    assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
});

test('legacy extraction cannot recover PASS outside an empty verdict section', () => {
    const content = '## Verdict\n## Notes\nREVIEW PASSED';
    assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
    assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
});

test('legacy extraction rejects contradictory verdicts after ordinary example prose', () => {
    const content = '## Verdict\nREVIEW PASSED\nExamples revealed a blocker.\nREVIEW FAILED';
    assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
    assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
});

test('legacy extraction rejects contradictory verdicts after a balanced inline code span', () => {
    const content = '## Verdict\nREVIEW PASSED\n```note```\nREVIEW FAILED';
    assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
    assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
});

test('legacy extraction rejects contradictory verdicts after an indented fence marker', () => {
    const content = '## Verdict\nREVIEW PASSED\n\n    ```\nREVIEW FAILED';
    assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
    assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
});

test('legacy extraction rejects authority after a literal bullet closer inside an example fence', () => {
    const content = '```markdown\n- ```\n## Verdict\nREVIEW PASSED\n```';
    assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
    assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
});

test('legacy extraction rejects an empty repeated explicit verdict section', () => {
    const content = '## Verdict\nREVIEW PASSED\n## Verdict\nAPPROVED';
    assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
    assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
});

test('legacy extraction rejects contradictory verdicts after excessive bullet indentation', () => {
    const content = '## Verdict\nREVIEW PASSED\n-     ```\nREVIEW FAILED';
    assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
    assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
});

test('legacy extraction rejects contradictory verdicts after leaving a list example', () => {
    const content = '## Verdict\nREVIEW PASSED\n- Examples:\nREVIEW FAILED';
    assert.equal(extractReviewVerdictSectionTokenMatch(content, CODE_TOKENS), null);
    assert.equal(extractReviewVerdictTokenMatch(content, CODE_TOKENS), null);
});

function findingsReport() {
    return {
        schema_version: 2,
        task_id: 'T-213-json-fixture',
        review_type: 'code',
        review_context_sha256: 'a'.repeat(64),
        tree_state_sha256: 'b'.repeat(64),
        validation_notes: [{
            id: 'N-001',
            topic: 'legacy-token-separation',
            note: 'The strings REVIEW PASSED and REVIEW FAILED are explanatory data in a findings-only report.',
            evidence: [{ location: 'src/example.ts:1', observation: 'The modern consumer derives the result from structured findings.' }]
        }],
        coverage_ledger: {
            coverage_contract_sha256: JSON_COVERAGE_CONTRACT.contract_sha256,
            entries: JSON_COVERAGE_CONTRACT.obligations.map((obligation) => ({
                obligation_id: obligation.id,
                evidence: [{ location: 'src/example.ts:1', observation: 'The complete scoped module was inspected.' }],
                finding_ids: [] as string[]
            }))
        },
        review_execution: {
            mode: 'FULL',
            contract_sha256: JSON_EXECUTION_CONTRACT.contract_sha256,
            covered_delta_targets: [],
            inspected_prior_finding_ids: []
        },
        findings: { critical: [], high: [] as object[], medium: [], low: [] },
        residual_risks: [],
        reviewer_notes: []
    };
}

function modernVerdict(report: object): string | null {
    return resolveReviewFindingsArtifactVerdictToken({
        content: JSON.stringify(report),
        passToken: PASS_TOKEN,
        failToken: FAIL_TOKEN,
        reviewType: 'code',
        expectedTaskId: 'T-213-json-fixture',
        expectedReviewContextSha256: 'a'.repeat(64),
        expectedTreeStateSha256: 'b'.repeat(64),
        coverageContract: JSON_COVERAGE_CONTRACT,
        expectedReviewExecutionContract: JSON_EXECUTION_CONTRACT
    });
}

test('modern JSON consumer derives PASS from empty findings despite legacy token prose', () => {
    assert.equal(modernVerdict(findingsReport()), PASS_TOKEN);
});

test('modern JSON consumer derives FAIL from structured findings despite legacy token prose', () => {
    const report = findingsReport();
    report.findings.high.push({
        id: 'F-001',
        title: 'Concrete regression',
        description: 'The changed branch accepts contradictory outcome authority.',
        evidence: [{ location: 'src/example.ts:1', observation: 'Contradictory tokens were reproduced.' }],
        coverage_obligation_ids: ['FILE-001']
    });
    report.coverage_ledger.entries[0].finding_ids.push('F-001');
    assert.equal(modernVerdict(report), FAIL_TOKEN);
});

test('modern JSON consumer rejects invalid schema instead of falling back to legacy tokens', () => {
    assert.equal(modernVerdict({ ...findingsReport(), schema_version: 999 }), null);
});
