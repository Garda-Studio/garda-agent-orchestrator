import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { buildTaskAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary';
import { resolveNextStepStartupRoute } from '../../../../src/gates/next-step/next-step-startup-routing';

const taskId = 'T-SPLIT-STARTUP-1';
const startupGates = ['enter-task-mode', 'load-rule-pack', 'handshake-diagnostics', 'shell-smoke-preflight'];

describe('incomplete aggregate startup projection', () => {
    let root: string, bundle: string;
    const add = (type: string, details: object = {}) => appendMandatoryTaskEvent(
        bundle, taskId, type, 'PASS', 'Native startup projection fixture.', details, { actor: 'orchestrator' }
    );
    const summary = () => buildTaskAuditSummary({ repoRoot: root, taskId });
    const startup = () => {
        add('TASK_MODE_ENTERED');
        add('RULE_PACK_LOADED', { stage: 'TASK_ENTRY' });
        add('HANDSHAKE_DIAGNOSTICS_RECORDED');
        add('SHELL_SMOKE_PREFLIGHT_RECORDED');
    };
    const split = () => add('STRICT_DECOMPOSITION_DECISION_RECORDED', { decision: 'split-required' });
    const route = (audit: ReturnType<typeof summary>) => {
        const passed = (gate: string) => audit.gates.some(entry => entry.gate === gate && entry.status === 'PASS');
        return resolveNextStepStartupRoute({
            enterTaskModePassed: passed(startupGates[0]), loadRulePackPassed: passed(startupGates[1]),
            handshakeDiagnosticsPassed: passed(startupGates[2]), shellSmokePreflightPassed: passed(startupGates[3]),
            defaultExecutionProvider: 'Codex', enterTaskModeCommand: 'enter', taskEntryRulePackCommand: 'rules',
            handshakeDiagnosticsCommand: 'handshake', shellSmokePreflightCommand: 'smoke',
            rulePackStage: 'TASK_ENTRY', preflightExists: false,
            startupCycleReadiness: { ready: true, nextGate: null, title: 'Test startup projection.', reason: 'Ordering is tested by its native owner.' }
        });
    };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-split-startup-'));
        bundle = path.join(root, 'garda-agent-orchestrator');
        fs.mkdirSync(path.join(bundle, 'runtime/reviews'), { recursive: true });
        fs.mkdirSync(path.join(bundle, 'live/config'), { recursive: true });
        const config = buildDefaultWorkflowConfig();
        config.full_suite_validation.enabled = false;
        config.project_memory_maintenance.enabled = false;
        fs.writeFileSync(path.join(bundle, 'live/config/workflow-config.json'), JSON.stringify(config));
        fs.writeFileSync(path.join(root, 'TASK.md'), [
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
            `| ${taskId} | IN_PROGRESS | P1 | audit | Split parent | test | 2026-10-16 | balanced | Child tasks: ${taskId}-1, ${taskId}-2 |`,
            `| ${taskId}-1 | DONE | P1 | audit | First child | test | 2026-10-16 | balanced | Source not qualified by this fixture. |`,
            `| ${taskId}-2 | DONE | P1 | audit | Second child | test | 2026-10-16 | balanced | Source not qualified by this fixture. |`
        ].join('\n') + '\n');
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('retains genuine startup observations after split without granting aggregate acceptance', () => {
        startup(); split();
        const audit = summary();
        assert.equal(audit.status, 'BLOCKED', 'Incomplete native decomposition and child proofs must stay blocked');
        assert.ok(audit.blockers.some(blocker => blocker.gate === 'decomposed-parent-obligations'));
        for (const gate of startupGates) assert.equal(audit.gates.find(entry => entry.gate === gate)?.status, 'PASS', gate);
        assert.equal(route(audit), null, 'Startup must let the navigator reach the existing split continuation');
        assert.equal(audit.final_report_contract.status, 'NOT_READY');
    });

    it('does not reuse an earlier startup after a later task-mode entry', () => {
        startup(); add('TASK_MODE_ENTERED'); split();
        const audit = summary();
        assert.equal(audit.status, 'BLOCKED');
        assert.equal(audit.gates.find(entry => entry.gate === startupGates[0])?.status, 'PASS');
        for (const gate of startupGates.slice(1)) assert.equal(audit.gates.find(entry => entry.gate === gate)?.status, 'MISSING', gate);
        assert.equal(route(audit)?.nextGate, 'load-rule-pack');
    });

    it('does not invent startup evidence from a split decision alone', () => {
        split();
        const audit = summary();
        assert.equal(audit.status, 'BLOCKED');
        for (const gate of startupGates) assert.equal(audit.gates.find(entry => entry.gate === gate)?.status, 'MISSING', gate);
        assert.equal(route(audit)?.nextGate, 'enter-task-mode');
    });

    it('keeps ordinary non-split startup projection unchanged', () => {
        startup();
        const audit = summary();
        for (const gate of startupGates) assert.equal(audit.gates.find(entry => entry.gate === gate)?.status, 'PASS', gate);
        assert.equal(route(audit), null);
        assert.ok(audit.gates.some(entry => entry.gate === 'completion-gate' && entry.status === 'MISSING'));
    });
});
