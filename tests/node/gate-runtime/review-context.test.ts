import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance,
    buildReviewReceiptReviewerProvenance,
    buildReviewVerdictTokenSet,
    extractReviewVerdictToken,
    formatAcceptedReviewVerdictTokens,
    compactMarkdownContent,
    getCompactReviewBudget,
    auditReviewArtifactCompaction,
    buildReviewContextSections,
    normalizeReviewReceiptReviewerProvenance
} from '../../../src/gate-runtime/review/review-context';
import { stringSha256 } from '../../../src/gate-runtime/hash';


test('compactMarkdownContent returns empty for null', () => {
    const result = compactMarkdownContent(null);
    assert.equal(result.content, '');
    assert.equal(result.original_char_count, 0);
    assert.equal(result.removed_code_blocks, 0);
});

test('compactMarkdownContent preserves content with no stripping', () => {
    const input = '# Title\n\nSome text.\n';
    const result = compactMarkdownContent(input);
    assert.equal(result.content, input);
    assert.equal(result.removed_code_blocks, 0);
    assert.equal(result.removed_example_sections, 0);
});

test('compactMarkdownContent strips example sections', () => {
    const input = '# Title\n\n## Examples\n\nExample text.\nMore example.\n\n## Next Section\n\nKeep this.\n';
    const result = compactMarkdownContent(input, { stripExamples: true });
    assert.ok(result.content.includes('> Example section omitted due to token economy.'));
    assert.ok(!result.content.includes('Example text.'));
    assert.ok(!result.content.includes('More example.'));
    assert.ok(result.content.includes('Next Section'));
    assert.ok(result.content.includes('Keep this.'));
    assert.equal(result.removed_example_sections, 1);
});

test('compactMarkdownContent retains structural code blocks under stripCodeBlocks', () => {
    const input = '### Setup\n\n```bash\nnpm install\n```\n\nMore text.\n';
    const result = compactMarkdownContent(input, { stripCodeBlocks: true });
    assert.ok(result.content.includes('npm install'), 'structural code block should be retained');
    assert.ok(result.content.includes('More text.'));
    assert.equal(result.removed_code_blocks, 0);
    assert.equal(result.retained_structural_code_blocks, 1);
});

test('compactMarkdownContent strips illustrative code blocks preceded by example label', () => {
    const input = 'Some rule.\n\nFor example:\n\n```python\nprint("hello")\n```\n\nMore text.\n';
    const result = compactMarkdownContent(input, { stripCodeBlocks: true });
    assert.ok(result.content.includes('> Code block omitted due to token economy.'));
    assert.ok(!result.content.includes('print("hello")'));
    assert.ok(result.content.includes('More text.'));
    assert.equal(result.removed_code_blocks, 1);
    assert.equal(result.retained_structural_code_blocks, 0);
});

test('compactMarkdownContent strips code blocks under example heading with stripCodeBlocks only', () => {
    const input = '## Example Usage\n\n```js\nconsole.log("demo")\n```\n\n## Config\n\n```bash\nnpm start\n```\n';
    const result = compactMarkdownContent(input, { stripCodeBlocks: true });
    assert.ok(!result.content.includes('console.log("demo")'), 'illustrative block should be stripped');
    assert.ok(result.content.includes('npm start'), 'structural block should be retained');
    assert.equal(result.removed_code_blocks, 1);
    assert.equal(result.retained_structural_code_blocks, 1);
});

test('compactMarkdownContent strips both examples and code blocks', () => {
    const input = '# Title\n\n## Example\n\n```js\nconsole.log("test")\n```\n\n## Other\n\nKeep.\n';
    const result = compactMarkdownContent(input, { stripExamples: true, stripCodeBlocks: true });
    assert.ok(!result.content.includes('console.log'));
    assert.ok(result.content.includes('Keep.'));
});

test('compactMarkdownContent preserves trailing newline', () => {
    const input = 'Hello\n';
    const result = compactMarkdownContent(input);
    assert.ok(result.content.endsWith('\n'));
});

test('compactMarkdownContent normalizes CRLF to LF', () => {
    const input = 'Hello\r\nWorld\r\n';
    const result = compactMarkdownContent(input);
    assert.ok(!result.content.includes('\r'));
});

test('compactMarkdownContent strips example label pattern', () => {
    const input = 'Rule text.\n\nExamples:\n\n```bash\necho hello\n```\n\nMore text.\n';
    const result = compactMarkdownContent(input, { stripExamples: true });
    assert.ok(result.content.includes('> Example content omitted'));
    assert.ok(result.content.includes('> Code block omitted'));
    assert.ok(!result.content.includes('echo hello'));
    assert.equal(result.removed_example_labels, 1);
    assert.equal(result.removed_code_blocks, 1);
});

test('compactMarkdownContent counts correctly', () => {
    const input = 'Line 1\nLine 2\nLine 3\n';
    const result = compactMarkdownContent(input);
    assert.equal(result.original_line_count, 4); // split "Line 1\nLine 2\nLine 3\n" → 4 elements
    assert.equal(result.original_char_count, input.replace(/\r\n/g, '\n').length);
});


test('compactMarkdownContent strips code block preceded by "e.g." phrase', () => {
    const input = 'Use a short name, e.g.\n\n```bash\nfoo --bar\n```\n\nNext section.\n';
    const result = compactMarkdownContent(input, { stripCodeBlocks: true });
    assert.ok(!result.content.includes('foo --bar'));
    assert.ok(result.content.includes('> Code block omitted'));
    assert.equal(result.removed_code_blocks, 1);
    assert.equal(result.retained_structural_code_blocks, 0);
});

test('compactMarkdownContent strips code block preceded by "such as"', () => {
    const input = 'Patterns such as\n\n```js\nconsole.log("x")\n```\n\nDone.\n';
    const result = compactMarkdownContent(input, { stripCodeBlocks: true });
    assert.ok(!result.content.includes('console.log'));
    assert.equal(result.removed_code_blocks, 1);
});

test('compactMarkdownContent strips code block preceded by "for instance"', () => {
    const input = 'For instance:\n\n```py\nprint(1)\n```\n';
    const result = compactMarkdownContent(input, { stripCodeBlocks: true });
    assert.ok(!result.content.includes('print(1)'));
    assert.equal(result.removed_code_blocks, 1);
});

test('compactMarkdownContent retains structural code block with no illustrative context', () => {
    const input = '## Commands\n\nRun the build:\n\n```bash\nnpm run build\n```\n\nDone.\n';
    const result = compactMarkdownContent(input, { stripCodeBlocks: true });
    assert.ok(result.content.includes('npm run build'));
    assert.equal(result.removed_code_blocks, 0);
    assert.equal(result.retained_structural_code_blocks, 1);
});

test('compactMarkdownContent handles mixed structural and illustrative blocks', () => {
    const input = [
        '## Setup',
        '',
        '```bash',
        'npm install',
        '```',
        '',
        'For example:',
        '',
        '```js',
        'doSomething()',
        '```',
        '',
        '## API',
        '',
        '```json',
        '{ "key": "value" }',
        '```',
        ''
    ].join('\n');
    const result = compactMarkdownContent(input, { stripCodeBlocks: true });
    assert.ok(result.content.includes('npm install'), 'setup block retained');
    assert.ok(!result.content.includes('doSomething()'), 'example block stripped');
    assert.ok(result.content.includes('"key": "value"'), 'API block retained');
    assert.equal(result.removed_code_blocks, 1);
    assert.equal(result.retained_structural_code_blocks, 2);
});

test('compactMarkdownContent retains code blocks when stripCodeBlocks is false', () => {
    const input = 'For example:\n\n```js\nfoo()\n```\n';
    const result = compactMarkdownContent(input, { stripCodeBlocks: false });
    assert.ok(result.content.includes('foo()'));
    assert.equal(result.removed_code_blocks, 0);
    assert.equal(result.retained_structural_code_blocks, 0);
});

test('compactMarkdownContent strips code block preceded by "like so"', () => {
    const input = 'Configure it like so\n\n```yaml\nkey: val\n```\n';
    const result = compactMarkdownContent(input, { stripCodeBlocks: true });
    assert.ok(!result.content.includes('key: val'));
    assert.equal(result.removed_code_blocks, 1);
});


test('getCompactReviewBudget returns default for null', () => {
    const budget = getCompactReviewBudget(null);
    assert.equal(budget.fail_tail_lines, 50);
    assert.equal(budget.max_lines, 120);
    assert.equal(budget.max_chars, 12000);
    assert.equal(budget.max_code_fence_lines, 4);
    assert.equal(budget.max_example_markers, 0);
});

test('getCompactReviewBudget respects custom fail_tail_lines', () => {
    const budget = getCompactReviewBudget(100);
    assert.equal(budget.fail_tail_lines, 100);
    assert.equal(budget.max_lines, 170); // max(120, 100+70)
    assert.equal(budget.max_chars, 17000); // max(12000, 170*100)
});

test('getCompactReviewBudget clamps to minimum 1', () => {
    const budget = getCompactReviewBudget(-10);
    assert.equal(budget.fail_tail_lines, 1);
});

test('getCompactReviewBudget handles boolean as default', () => {
    const budget = getCompactReviewBudget(true);
    assert.equal(budget.fail_tail_lines, 50);
});

test('getCompactReviewBudget handles string input', () => {
    const budget = getCompactReviewBudget('75');
    assert.equal(budget.fail_tail_lines, 75);
});


test('auditReviewArtifactCompaction not expected when not active', () => {
    const result = auditReviewArtifactCompaction({
        artifactPath: 'test.md',
        content: 'Some content.',
        reviewContext: {}
    });
    assert.equal(result.expected, false);
    assert.equal(result.warning_count, 0);
});

test('auditReviewArtifactCompaction warns on budget exceed', () => {
    const longContent = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join('\n');
    const result = auditReviewArtifactCompaction({
        artifactPath: 'test.md',
        content: longContent,
        reviewContext: {
            token_economy_active: true,
            token_economy: {
                active: true,
                flags: { compact_reviewer_output: true, fail_tail_lines: 50 }
            }
        }
    });
    assert.equal(result.expected, true);
    assert.ok(result.warning_count > 0);
    assert.ok(result.warnings.some((w: string) => w.includes('exceeds compact line budget')));
});

test('auditReviewArtifactCompaction ignores pretty-print lines for structured JSON', () => {
    const structuredContent = JSON.stringify({
        schema_version: 2,
        coverage_ledger: {
            entries: Array.from({ length: 40 }, (_, index) => ({
                obligation_id: `O-${index}`,
                finding_ids: []
            }))
        }
    }, null, 2);
    const result = auditReviewArtifactCompaction({
        artifactPath: 'test.md',
        content: structuredContent,
        reviewContext: {
            token_economy_active: true,
            token_economy: {
                active: true,
                flags: { compact_reviewer_output: true, fail_tail_lines: 50 }
            }
        }
    });

    assert.ok(result.line_count > result.budget.max_lines);
    assert.ok(result.char_count < result.budget.max_chars);
    assert.equal(result.line_budget_mode, 'character_only_for_structured_json');
    assert.equal(result.warning_count, 0);
});

test('auditReviewArtifactCompaction retains the character budget for structured JSON', () => {
    const structuredContent = JSON.stringify({ reviewer_notes: ['x'.repeat(13000)] }, null, 2);
    const result = auditReviewArtifactCompaction({
        artifactPath: 'test.md',
        content: structuredContent,
        reviewContext: {
            token_economy_active: true,
            token_economy: {
                active: true,
                flags: { compact_reviewer_output: true, fail_tail_lines: 50 }
            }
        }
    });

    assert.equal(result.line_budget_mode, 'character_only_for_structured_json');
    assert.ok(result.warnings.some((warning: string) => warning.includes('exceeds compact char budget')));
});


test('buildReviewContextSections builds artifact from mock files', () => {
    const files: Record<string, string> = {
        'rules/rule-1.md': '# Rule 1\n\nSome content.\n',
        'rules/rule-2.md': '# Rule 2\n\n## Example\n\nSkip this.\n\n## Important\n\nKeep this.\n'
    };

    const result = buildReviewContextSections(
        Object.keys(files),
        (path) => files[path],
        { stripExamples: true }
    );

    assert.equal(result.source_file_count, 2);
    assert.ok(result.artifact_text.includes('# Reviewer Rule Context'));
    assert.ok(result.artifact_text.includes('## Source: rules/rule-1.md'));
    assert.ok(result.artifact_text.includes('## Source: rules/rule-2.md'));
    assert.ok(result.artifact_text.includes('Some content.'));
    assert.ok(!result.artifact_text.includes('Skip this.'));
    assert.ok(result.artifact_text.includes('Keep this.'));
    assert.ok(result.artifact_text.includes('> Example section omitted'));
    assert.match(result.artifact_sha256!, /^[0-9a-f]{64}$/);

    // Verify summary totals
    const summary = result.summary as Record<string, number>;
    assert.ok(summary.original_line_count > 0);
    assert.ok(summary.original_char_count > 0);
    assert.ok(summary.original_token_count_estimate > 0);

    // Verify each file entry has content_sha256
    for (const entry of result.source_files) {
        assert.match(entry.content_sha256!, /^[0-9a-f]{64}$/);
    }
});

test('buildReviewContextSections handles empty rule file', () => {
    const result = buildReviewContextSections(
        ['empty.md'],
        () => '',
        { stripExamples: true, stripCodeBlocks: true }
    );

    assert.equal(result.source_file_count, 1);
    assert.ok(result.artifact_text.includes('_No remaining content after token-economy compaction._'));
});

test('buildReviewContextSections includes strip flags in header', () => {
    const result = buildReviewContextSections(
        ['test.md'],
        () => '# Test\nContent.\n',
        { stripExamples: true, stripCodeBlocks: false }
    );

    assert.ok(result.artifact_text.includes('- strip_examples: true'));
    assert.ok(result.artifact_text.includes('- strip_code_blocks: false'));
});

test('applyReviewerRoutingMetadata updates review-context routing fields and returns sha', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-context-'));
    const contextPath = path.join(tempDir, 'T-901-code-review-context.json');
    fs.writeFileSync(contextPath, JSON.stringify({
        review_type: 'code',
        reviewer_routing: {
            source_of_truth: 'Codex',
            actual_execution_mode: null,
            reviewer_session_id: null,
            fallback_reason: null
        }
    }, null, 2) + '\n', 'utf8');

    const result = applyReviewerRoutingMetadata(contextPath, {
        actualExecutionMode: 'delegated_subagent',
        reviewerSessionId: 'agent:reviewer-1',
        fallbackReason: null
    });

    const updated = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    assert.equal(result.updated, true);
    assert.equal(updated.reviewer_routing.actual_execution_mode, 'delegated_subagent');
    assert.equal(updated.reviewer_routing.reviewer_session_id, 'agent:reviewer-1');
    assert.equal(updated.reviewer_routing.fallback_reason, null);
    assert.equal(result.contextSha256, stringSha256(fs.readFileSync(contextPath, 'utf8')));

    const repeated = applyReviewerRoutingMetadata(contextPath, {
        actualExecutionMode: 'delegated_subagent',
        reviewerSessionId: 'agent:reviewer-1',
        fallbackReason: null
    });
    assert.equal(repeated.contextSha256, result.contextSha256);

    const changedIdentity = applyReviewerRoutingMetadata(contextPath, {
        actualExecutionMode: 'delegated_subagent',
        reviewerSessionId: 'agent:reviewer-2',
        fallbackReason: null
    });
    assert.notEqual(changedIdentity.contextSha256, result.contextSha256);

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('buildReviewReceipt defaults trust_level to LOCAL_ASSERTED', () => {
    const receipt = buildReviewReceipt({
        taskId: 'T-1001',
        reviewType: 'code',
        preflightSha256: 'preflight',
        scopeSha256: 'scope',
        reviewContextSha256: 'context',
        reviewArtifactSha256: 'artifact'
    });

    assert.equal(receipt.trust_level, 'LOCAL_ASSERTED');
});

test('buildReviewReceipt preserves explicit trust_level', () => {
    const receipt = buildReviewReceipt({
        taskId: 'T-1001',
        reviewType: 'code',
        preflightSha256: 'preflight',
        scopeSha256: 'scope',
        reviewContextSha256: 'context',
        reviewArtifactSha256: 'artifact',
        trustLevel: 'LOCAL_AUDITED'
    });

    assert.equal(receipt.trust_level, 'LOCAL_AUDITED');
});

test('buildReviewReceipt preserves explicit non-canonical trust_level for downstream validator normalization', () => {
    const receipt = buildReviewReceipt({
        taskId: 'T-1001',
        reviewType: 'code',
        preflightSha256: 'preflight',
        scopeSha256: 'scope',
        reviewContextSha256: 'context',
        reviewArtifactSha256: 'artifact',
        trustLevel: ' local_audited '
    });

    assert.equal(receipt.trust_level, ' local_audited ');
});

test('buildReviewReceipt preserves explicit reviewer_provenance', () => {
    const provenance = buildReviewReceiptReviewerProvenance('REVIEWER_DELEGATION_ROUTED', {
        schema_version: 1,
        task_sequence: 7,
        prev_event_sha256: 'a'.repeat(64),
        event_sha256: 'b'.repeat(64)
    });
    const receipt = buildReviewReceipt({
        taskId: 'T-1001',
        reviewType: 'code',
        preflightSha256: 'preflight',
        scopeSha256: 'scope',
        reviewContextSha256: 'context',
        reviewArtifactSha256: 'artifact',
        reviewerProvenance: provenance
    });

    assert.deepEqual(receipt.reviewer_provenance, provenance);
});

test('buildReviewReceipt preserves explicit domain_scope_fingerprints', () => {
    const fingerprints = {
        schema_version: 1 as const,
        detection_source: 'explicit_changed_files',
        include_untracked: true,
        use_staged: false,
        domains: {
            implementation: {
                changed_files: ['src/app.ts'],
                changed_files_count: 1,
                changed_files_sha256: 'a'.repeat(64),
                scope_content_sha256: 'b'.repeat(64),
                scope_sha256: 'c'.repeat(64)
            },
            test: {
                changed_files: [],
                changed_files_count: 0,
                changed_files_sha256: 'd'.repeat(64),
                scope_content_sha256: 'e'.repeat(64),
                scope_sha256: 'f'.repeat(64)
            },
            docs: {
                changed_files: [],
                changed_files_count: 0,
                changed_files_sha256: '1'.repeat(64),
                scope_content_sha256: '2'.repeat(64),
                scope_sha256: '3'.repeat(64)
            },
            config: {
                changed_files: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                changed_files_count: 1,
                changed_files_sha256: '4'.repeat(64),
                scope_content_sha256: '5'.repeat(64),
                scope_sha256: '6'.repeat(64)
            },
            closeout: {
                changed_files: ['TASK.md'],
                changed_files_count: 1,
                changed_files_sha256: '7'.repeat(64),
                scope_content_sha256: '8'.repeat(64),
                scope_sha256: '9'.repeat(64)
            }
        },
        legacy: {
            review_scope_sha256: 'a1'.repeat(32),
            code_scope_sha256: 'b1'.repeat(32),
            non_test_review_scope_sha256: 'c1'.repeat(32),
            code_review_scope_sha256: 'd1'.repeat(32)
        }
    };
    const receipt = buildReviewReceipt({
        taskId: 'T-1001',
        reviewType: 'code',
        preflightSha256: 'preflight',
        scopeSha256: 'scope',
        reviewContextSha256: 'context',
        reviewArtifactSha256: 'artifact',
        domainScopeFingerprints: fingerprints
    });

    assert.deepEqual(receipt.domain_scope_fingerprints, fingerprints);
});

test('normalizeReviewReceiptReviewerProvenance accepts controller event integrity evidence', () => {
    const normalized = normalizeReviewReceiptReviewerProvenance({
        schema_version: 1,
        attestation_type: 'controller_event_integrity',
        controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
        task_sequence: 9,
        prev_event_sha256: 'c'.repeat(64),
        event_sha256: 'd'.repeat(64)
    });

    assert.deepEqual(normalized, {
        schema_version: 1,
        attestation_type: 'controller_event_integrity',
        controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
        task_sequence: 9,
        prev_event_sha256: 'c'.repeat(64),
        event_sha256: 'd'.repeat(64)
    });
});

test('buildReviewReceiptReviewerInvocationProvenance preserves review tree-state binding', () => {
    const provenance = buildReviewReceiptReviewerInvocationProvenance(
        'REVIEWER_INVOCATION_ATTESTED',
        {
            schema_version: 1,
            task_sequence: 11,
            prev_event_sha256: 'e'.repeat(64),
            event_sha256: 'f'.repeat(64)
        },
        {
            task_id: 'T-1001',
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: 'agent:reviewer-1',
            review_context_sha256: '1'.repeat(64),
            review_tree_state_sha256: '2'.repeat(64),
            routing_event_sha256: '3'.repeat(64)
        }
    );

    assert.equal(provenance?.attestation_type, 'reviewer_invocation_attestation');
    assert.equal(provenance?.review_context_sha256, '1'.repeat(64));
    assert.equal(provenance?.review_tree_state_sha256, '2'.repeat(64));
    assert.equal(provenance?.routing_event_sha256, '3'.repeat(64));
});

test('normalizeReviewReceiptReviewerProvenance rejects malformed timing provenance', () => {
    const provenance = normalizeReviewReceiptReviewerProvenance({
        schema_version: 1,
        attestation_type: 'reviewer_invocation_attestation',
        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
        task_sequence: 11,
        prev_event_sha256: 'e'.repeat(64),
        event_sha256: 'f'.repeat(64),
        task_id: 'T-1001',
        review_type: 'code',
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: 'agent:reviewer-1',
        review_context_sha256: '1'.repeat(64),
        review_tree_state_sha256: '2'.repeat(64),
        routing_event_sha256: '3'.repeat(64),
        launch_prepared_at_utc: 'not-a-date'
    });

    assert.equal(provenance, null);
});

test('extractReviewVerdictToken prefers verdict section tokens', () => {
    const verdict = extractReviewVerdictToken([
        '# Review',
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Verdict',
        'TEST REVIEW PASSED'
    ].join('\n'), 'TEST REVIEW PASSED', 'TEST REVIEW FAILED');

    assert.equal(verdict, 'TEST REVIEW PASSED');
});

test('extractReviewVerdictToken falls back to exact token lines outside verdict section', () => {
    const verdict = extractReviewVerdictToken('# Review\nREVIEW FAILED\n', 'REVIEW PASSED', 'REVIEW FAILED');
    assert.equal(verdict, 'REVIEW FAILED');
});

test('extractReviewVerdictToken accepts canonical bullet-form verdict lines', () => {
    const verdict = extractReviewVerdictToken([
        '# Review',
        '',
        '## Verdict',
        '- `REVIEW PASSED`'
    ].join('\n'), 'REVIEW PASSED', 'REVIEW FAILED');

    assert.equal(verdict, 'REVIEW PASSED');
});

test('extractReviewVerdictToken accepts typed code aliases and normalizes to canonical verdicts', () => {
    const failedVerdict = extractReviewVerdictToken([
        '# Review',
        '',
        '## Verdict',
        'CODE REVIEW FAILED'
    ].join('\n'), 'REVIEW PASSED', 'REVIEW FAILED', 'code');
    const passedVerdict = extractReviewVerdictToken([
        '# Review',
        '',
        '## Verdict',
        '- CODE REVIEW PASSED'
    ].join('\n'), 'REVIEW PASSED', 'REVIEW FAILED', 'code');

    assert.equal(failedVerdict, 'REVIEW FAILED');
    assert.equal(passedVerdict, 'REVIEW PASSED');
});

test('extractReviewVerdictToken accepts canonical typed review verdicts', () => {
    const dbFailedVerdict = extractReviewVerdictToken([
        '# Review',
        '',
        '## Verdict',
        'DB REVIEW FAILED'
    ].join('\n'), 'DB REVIEW PASSED', 'DB REVIEW FAILED', 'db');
    const securityPassedVerdict = extractReviewVerdictToken([
        '# Review',
        '',
        '## Verdict',
        'SECURITY REVIEW PASSED'
    ].join('\n'), 'SECURITY REVIEW PASSED', 'SECURITY REVIEW FAILED', 'security');

    assert.equal(dbFailedVerdict, 'DB REVIEW FAILED');
    assert.equal(securityPassedVerdict, 'SECURITY REVIEW PASSED');
});

test('extractReviewVerdictToken rejects generic aliases for typed review contracts', () => {
    const dbFailedVerdict = extractReviewVerdictToken([
        '# Review',
        '',
        '## Verdict',
        'REVIEW FAILED'
    ].join('\n'), 'DB REVIEW PASSED', 'DB REVIEW FAILED', 'db');
    const securityPassedVerdict = extractReviewVerdictToken([
        '# Review',
        '',
        '## Verdict',
        'REVIEW PASSED'
    ].join('\n'), 'SECURITY REVIEW PASSED', 'SECURITY REVIEW FAILED', 'security');

    assert.equal(dbFailedVerdict, null);
    assert.equal(securityPassedVerdict, null);
});

test('extractReviewVerdictToken rejects embedded or fuzzy verdict prose', () => {
    const embeddedVerdict = extractReviewVerdictToken([
        '# Review',
        '',
        'The reviewer mentioned SECURITY REVIEW PASSED in explanatory prose, but did not issue a verdict.',
        '',
        '## Verdict',
        'The final verdict is SECURITY REVIEW PASSED.'
    ].join('\n'), 'SECURITY REVIEW PASSED', 'SECURITY REVIEW FAILED', 'security');
    const suffixedVerdict = extractReviewVerdictToken([
        '# Review',
        '',
        '## Verdict',
        'SECURITY REVIEW PASSED after checking the parser.'
    ].join('\n'), 'SECURITY REVIEW PASSED', 'SECURITY REVIEW FAILED', 'security');

    assert.equal(embeddedVerdict, null);
    assert.equal(suffixedVerdict, null);
});

test('formatAcceptedReviewVerdictTokens reports pass and fail aliases', () => {
    const tokens = buildReviewVerdictTokenSet('code', 'REVIEW PASSED', 'REVIEW FAILED');
    const message = formatAcceptedReviewVerdictTokens(tokens);

    assert.ok(message.includes("'REVIEW PASSED'"));
    assert.ok(message.includes("'CODE REVIEW PASSED'"));
    assert.ok(message.includes("'REVIEW FAILED'"));
    assert.ok(message.includes("'CODE REVIEW FAILED'"));
});

test('extractReviewVerdictToken returns null when no exact verdict token exists', () => {
    const verdict = extractReviewVerdictToken('# Review\nVerdict pending.\n', 'REVIEW PASSED', 'REVIEW FAILED');
    assert.equal(verdict, null);
});
