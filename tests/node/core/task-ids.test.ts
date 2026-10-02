import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assertCanonicalTaskId,
    KNOWN_REVIEW_ARTIFACT_SUFFIXES,
    parseKnownReviewArtifactTaskId,
    parseStructuredTaskArtifactTaskId,
    parseTaskIdJsonlFileName
} from '../../../src/core/task-ids';

test('assertCanonicalTaskId accepts semantic task ids', () => {
    assert.equal(assertCanonicalTaskId('T-001'), 'T-001');
    assert.equal(assertCanonicalTaskId('T-704-1'), 'T-704-1');
    assert.equal(assertCanonicalTaskId('T-CLI-ART'), 'T-CLI-ART');
    assert.equal(assertCanonicalTaskId('T-608-1-1-2'), 'T-608-1-1-2');
});

test('assertCanonicalTaskId rejects invalid and reserved runtime names', () => {
    for (const invalidTaskId of ['--help', 'all-tasks', '.', '..', '.hidden', '-T-001', 'timeline-summary', '.timeline-summary', 'index']) {
        assert.throws(() => assertCanonicalTaskId(invalidTaskId), /semantic pattern|reserved/);
    }
});

test('parseTaskIdJsonlFileName ignores reserved and invalid timeline files', () => {
    assert.equal(parseTaskIdJsonlFileName('T-001.jsonl'), 'T-001');
    assert.equal(parseTaskIdJsonlFileName('T-704-1.jsonl'), 'T-704-1');
    assert.equal(parseTaskIdJsonlFileName('T-CLI-ART.jsonl'), 'T-CLI-ART');
    assert.equal(parseTaskIdJsonlFileName('T-608-1-1-2.jsonl'), 'T-608-1-1-2');

    for (const invalidFileName of ['--help.jsonl', 'all-tasks.jsonl', '..jsonl', '.hidden.jsonl', '-T-001.jsonl', 'timeline-summary.jsonl', '.timeline-summary.jsonl', 'index.jsonl']) {
        assert.equal(parseTaskIdJsonlFileName(invalidFileName), null);
    }
});

test('parseStructuredTaskArtifactTaskId keeps lowercase follow-up suffix ownership', () => {
    assert.equal(
        parseStructuredTaskArtifactTaskId('T-506-f1-reset-report.json'),
        'T-506-f1'
    );
});

test('parseStructuredTaskArtifactTaskId keeps uppercase follow-up suffix ownership', () => {
    assert.equal(
        parseStructuredTaskArtifactTaskId('T-506-F1-reset-report.json'),
        'T-506-F1'
    );
});

test('parseStructuredTaskArtifactTaskId keeps semantic alphanumeric task ids intact', () => {
    assert.equal(
        parseStructuredTaskArtifactTaskId('T-CLI-ART-preflight.json'),
        'T-CLI-ART'
    );
    assert.equal(
        parseStructuredTaskArtifactTaskId('T-LONG-CHILD-reset-report.json'),
        'T-LONG-CHILD'
    );
});

test('parseStructuredTaskArtifactTaskId rejects unknown artifact suffixes', () => {
    assert.equal(parseStructuredTaskArtifactTaskId('T-CLI-ART-custom.json'), null);
    assert.equal(parseStructuredTaskArtifactTaskId('T--001-preflight.json'), null);
    assert.equal(parseStructuredTaskArtifactTaskId('T-001.hidden-preflight.json'), null);
});

test('parseStructuredTaskArtifactTaskId keeps legacy numeric unknown artifact ownership', () => {
    assert.equal(parseStructuredTaskArtifactTaskId('T-004-recent.json'), 'T-004');
    assert.equal(parseStructuredTaskArtifactTaskId('T-506-F1-bad-custom.json'), 'T-506-F1');
});

test('canonical cleanup suffixes retain semantic and nested task ownership', () => {
    const suffixes = [
        '-final-user-report.md',
        '-coherent-cycle-restart.json',
        '-review-cycle-restart.json',
        '-quality-checklist.json',
        '-quality-checklist-answers.json',
        '-scoped-summary.json',
        '-scoped-summary.md',
        '-task-plan.json'
    ];
    for (const taskId of ['T-CLEANUP-ART', 'T-991-1-F1', 'T-991-1-F1-I1']) {
        for (const suffix of suffixes) {
            for (const compressedSuffix of ['', '.gz']) {
                const fileName = `${taskId}${suffix}${compressedSuffix}`;
                assert.equal(parseKnownReviewArtifactTaskId(fileName, KNOWN_REVIEW_ARTIFACT_SUFFIXES), taskId, fileName);
                assert.equal(parseStructuredTaskArtifactTaskId(fileName), taskId, fileName);
            }
        }
    }
});
