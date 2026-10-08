import test from 'node:test';
import assert from 'node:assert/strict';

import { LIFECYCLE_EVENT_TYPES } from '../../../src/gate-runtime/timeline/lifecycle-event-types';
import { assertGenericTaskEventAdmission } from '../../../src/gate-runtime/timeline/task-event-generic-admission';

test('generic event admission rejects native lifecycle event vocabulary', () => {
    for (const eventType of Object.values(LIFECYCLE_EVENT_TYPES)) {
        assert.throws(() => assertGenericTaskEventAdmission(eventType), /reserved/u, eventType);
    }
});

test('generic event admission rejects status, split and continuation authority consumed by the navigator', () => {
    assert.throws(() => assertGenericTaskEventAdmission('SPLIT_REQUIRED_LATCHED'), /reserved/u);
    for (const eventType of [
        'STATUS_CHANGED', 'TASK_DONE', 'TASK_BLOCKED', 'TASK_FAILED',
        'SPLIT_REQUIRED_LATCHED', 'SPLIT_REQUIRED_CLEARED',
        'REVIEW_CYCLE_CONTINUATION_APPROVED', 'CONTINUATION_APPROVED',
        'STRICT_DECOMPOSITION_SPLIT_ROUTED', 'DECOMPOSED_PARENT_COMPLETED'
    ]) {
        assert.throws(() => assertGenericTaskEventAdmission(eventType), /reserved/u, eventType);
    }
});

test('generic event admission preserves the existing gate, review and workflow authority boundary', () => {
    for (const eventType of [
        'COMPILE_GATE_PASSED', 'REVIEW_GATE_PASSED', 'REVIEW_RECORDED',
        'REVIEWER_INVOCATION_ATTESTED', 'PREFLIGHT_CLASSIFIED',
        'COMPLETION_GATE_PASSED', 'FULL_SUITE_VALIDATION_PASSED',
        'DOC_IMPACT_ASSESSED', 'WORKFLOW_CONFIG_MUTATION_AUDITED',
        'WORKFLOW_CONFIG_MUTATION_PREPARED', 'PROJECT_MEMORY_IMPACT_ASSESSED',
        'QUALITY_CHECKLIST_RECORDED', 'INTERMEDIATE_COMMAND_RECORDED',
        'TEST_FIRST_EXPECTED_RED_RECORDED'
    ]) {
        assert.throws(() => assertGenericTaskEventAdmission(eventType), /reserved/u, eventType);
    }
});

test('generic event admission reserves authority namespaces beyond individual known event names', () => {
    for (const eventType of [
        'TASK_FUTURE_TRANSITION', 'STATUS_FUTURE_TRANSITION',
        'SPLIT_REQUIRED_FUTURE_DECISION', 'CONTINUATION_FUTURE_DECISION',
        'STRICT_DECOMPOSITION_FUTURE_DECISION', 'DECOMPOSED_PARENT_FUTURE_DECISION',
        'REVIEW_FUTURE_RECEIPT', 'REVIEWER_FUTURE_ATTESTATION',
        'WORKFLOW_CONFIG_FUTURE_GRANT', 'FULL_SUITE_VALIDATION_FUTURE_RESULT'
    ]) {
        assert.throws(() => assertGenericTaskEventAdmission(eventType), /reserved/u, eventType);
    }
});

test('generic event admission rejects bypass attempts with casing or surrounding whitespace', () => {
    assert.throws(() => assertGenericTaskEventAdmission(' \tStatus_Changed\n'), /reserved/u);
    for (const eventType of ['status_changed', '  Task_Done  ', '\nreview_cycle_continuation_approved\t', ' split_required_latched ']) {
        assert.throws(() => assertGenericTaskEventAdmission(eventType), /reserved/u, JSON.stringify(eventType));
    }
});

test('generic event admission accepts ordinary informational events without altering their names', () => {
    for (const eventType of ['USER_NOTE', 'COMMAND_EXECUTED', 'DEBUG_NOTE', 'CUSTOM_EVENT', 'agent observation', '  Custom_Note  ']) {
        const original = eventType;
        assert.equal(assertGenericTaskEventAdmission(eventType), undefined);
        assert.equal(eventType, original);
    }
});

test('generic event admission matches authority namespaces rather than substrings', () => {
    for (const eventType of ['USER_TASK_NOTE', 'DEBUG_STATUS_NOTE', 'MY_REVIEW_OBSERVATION', 'NOTE_ABOUT_SPLIT_REQUIRED']) {
        assert.doesNotThrow(() => assertGenericTaskEventAdmission(eventType));
    }
});

test('generic event name policy leaves authenticated defect acknowledgement to its existing dedicated admission', () => {
    assert.doesNotThrow(() => assertGenericTaskEventAdmission('ORCHESTRATOR_DEFECT_ACKNOWLEDGED'));
});

test('generic event admission rejects empty and non-string names before any caller writes evidence', () => {
    assert.throws(() => assertGenericTaskEventAdmission({ toString: () => 'USER_NOTE' }), /non-empty string/u);
    for (const eventType of ['', ' \t\n ', undefined, null, 0, false, {}, ['USER_NOTE']]) {
        assert.throws(() => assertGenericTaskEventAdmission(eventType), /non-empty string/u);
    }
});
