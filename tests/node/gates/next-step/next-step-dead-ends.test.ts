import test from 'node:test';
import assert from 'node:assert/strict';

import { buildNextStepInstruction } from '../../../../src/gates/next-step/next-step-command-formatters';
import { buildOperatorNextActionBlock } from '../../../../src/gates/shared/operator-action-output';

const base = {
    task_id: 'T-9',
    navigator_command: 'node garda-agent-orchestrator/bin/garda.js next-step "T-9" --repo-root "."',
    commands: [] as never[]
};

test('every commandless non-terminal navigator result carries a one-line instruction', () => {
    const gates = [
        'quality-checklist', 'run-intermediate-command', 'project-validation-evidence', 'await-project-validation',
        'implementation', 'test-first-expected-failure', 'materialize-planned-scope', 'split-required-latch',
        'task-metadata-validation', null
    ];
    for (const gate of gates) {
        const instruction = buildNextStepInstruction({ ...base, status: 'BLOCKED', next_gate: gate });
        assert.ok(instruction, String(gate));
        assert.match(instruction!, /rerun the Navigator\.$/u, String(gate));
        assert.ok(instruction!.length <= 400, `${String(gate)} instruction must stay short`);
    }
});

test('run-intermediate-command instruction is an editable command with the selected-case shape', () => {
    const instruction = buildNextStepInstruction({ ...base, status: 'BLOCKED', next_gate: 'run-intermediate-command' })!;
    assert.ok(instruction.startsWith('node garda-agent-orchestrator/bin/garda.js gate run-intermediate-command --task-id'));
    assert.match(instruction, /--command-source targeted-test --command "<project focused test command>"/u);
    assert.match(instruction, /--selected-case/u);
});

test('no instruction when a command exists or the task is done', () => {
    const command = { label: 'Run', command: 'garda gate compile-gate' } as never;
    assert.equal(buildNextStepInstruction({ ...base, status: 'BLOCKED', next_gate: 'compile-gate', commands: [command] }), null);
    assert.equal(buildNextStepInstruction({ ...base, status: 'DONE', next_gate: null }), null);
});

test('operator block prints Next instead of a no-command dead end', () => {
    const lines = buildOperatorNextActionBlock({
        status: 'BLOCKED', gate: 'quality-checklist', action: 'Complete quality checklist answers.',
        reason: 'Complete every active answer in runtime/tmp/T-9-answers.json.', command: null,
        nextInstruction: 'fill "status" and "answer" for every active rule in the answers file named in Reason, then rerun the Navigator.'
    });
    assert.ok(lines.includes('  Command: none'));
    assert.ok(lines.some(line => line.startsWith('  Next: fill "status" and "answer"')));
    assert.ok(!lines.some(line => /no executable command is available/u.test(line)));
});

test('Next names the checklist answers file and binds focused checks to the current preflight', () => {
    const checklist = buildNextStepInstruction({
        ...base, status: 'BLOCKED', next_gate: 'quality-checklist',
        reason: 'Rules a, b, c pending. Complete every active answer in "garda-agent-orchestrator/runtime/tmp/T-9-quality-checklist-answers.json" and rerun next-step.'
    })!;
    assert.match(checklist, /in garda-agent-orchestrator\/runtime\/tmp\/T-9-quality-checklist-answers\.json,/u);
    assert.match(checklist, /PASS, WARN or ACTION_REQUIRED/u);
    assert.match(checklist, /"path#exact test name"/u);
    assert.ok(checklist.length <= 400, checklist);
    const focused = buildNextStepInstruction({ ...base, status: 'BLOCKED', next_gate: 'run-intermediate-command' })!;
    assert.match(focused, /--preflight-path "garda-agent-orchestrator\/runtime\/reviews\/T-9-preflight\.json"/u);
});

test('Next reruns an unbound selected case with that case pre-filled', () => {
    const instruction = buildNextStepInstruction({
        ...base, status: 'BLOCKED', next_gate: 'project-validation-evidence',
        reason: 'Native case execution is unavailable: The latest matching command for src/test/java/example/InvoiceTest.java / discountRejectsInvalidInput is not an authenticated successful execution.'
    })!;
    assert.match(instruction, /gate run-intermediate-command --task-id "T-9"/u);
    assert.match(instruction, /--selected-case '\{"source":"src\/test\/java\/example\/InvoiceTest\.java","case_id":"discountRejectsInvalidInput","selector":"<selector>"\}'/u);
    // A ready command carries real paths, so it gets more room than a text instruction.
    assert.ok(instruction.length <= 500);
});

test('Next gives a concrete fresh-run command after rejected or stale focused evidence', () => {
    const instruction = buildNextStepInstruction({
        ...base, status: 'BLOCKED', next_gate: 'project-validation-evidence',
        reason: 'Native case execution is unavailable; focused intermediate evidence candidate seq=27/21 rejected: stale or foreign task/cycle binding.'
    })!;
    assert.match(instruction, /record a fresh current run: .*gate run-intermediate-command --task-id "T-9"/u);
    assert.match(instruction, /--preflight-path "garda-agent-orchestrator\/runtime\/reviews\/T-9-preflight\.json"/u);
    assert.ok(instruction.length <= 400, instruction);
});

test('Next reruns rejected declared evidence through its admitted recipe', () => {
    for (const reason of [
        'Recipe focused-java retained FAILED.',
        'Recipe focused-java evidence rejected: Error: Foreign validation quality snapshot'
    ]) {
        const instruction = buildNextStepInstruction({
            ...base, status: 'BLOCKED', next_gate: 'project-validation-evidence', reason
        })!;
        assert.match(instruction, /gate run-intermediate-command --task-id "T-9" --recipe-id "focused-java"/u);
        assert.doesNotMatch(instruction, /--command-source targeted-test/u);
        assert.ok(instruction.length <= 400, instruction);
    }
});

test('Next requests contract re-approval and preflight refresh for validation authority rejections', () => {
    for (const reason of [
        'Error: Project validation authority changed; refresh preflight after audited admission',
        'Error: Project validation authority lacks an explicit recipe admission and current audited workflow configuration mutation',
        'Error: Unsupported audited workflow configuration mutation origin',
        'Recipe focused-java evidence rejected: Error: Approved dependency changed: driver.cjs',
        'Recipe focused-java evidence rejected: Error: Approved executable identity changed'
    ]) {
        const instruction = buildNextStepInstruction({
            ...base, status: 'BLOCKED', next_gate: 'project-validation-evidence', reason
        })!;
        assert.match(instruction, /operator confirm or re-approve the project validation contract/u);
        assert.match(instruction, /workflow set --project-validation-contract "<contract path>"/u);
        assert.match(instruction, /refresh preflight with classify-change/u);
        assert.doesNotMatch(instruction, /gate run-intermediate-command|--command-source targeted-test/u);
        assert.ok(instruction.length <= 400, instruction);
    }
});

test('Next does not prescribe a native focused command for an unclassified declared validation rejection', () => {
    const instruction = buildNextStepInstruction({
        ...base, status: 'BLOCKED', next_gate: 'project-validation-evidence',
        reason: 'Error: Validation quality preflight changed'
    })!;
    assert.match(instruction, /resolve the declared validation rejection in Reason/u);
    assert.match(instruction, /admitted --recipe-id/u);
    assert.doesNotMatch(instruction, /--command-source targeted-test/u);
});
