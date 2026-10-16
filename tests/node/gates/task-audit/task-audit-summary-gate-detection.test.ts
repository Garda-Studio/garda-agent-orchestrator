import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { appendMandatoryTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildStrictDecompositionDecisionArtifact } from '../../../../src/gates/task-mode/strict-decomposition-decision';

const nativeParentApi = require('../../../../src/gates/task-audit/task-audit-summary-lifecycle');
const nativeChildApi = require('../../../../src/gates/task-audit/task-audit-summary-decomposed-parent-proofs');
const parentObligationApi = require('../../../../src/gates/task-audit/task-audit-summary-parent-obligation-proofs');

function nativeParentReader(): typeof import('../../../../src/gates/task-audit/task-audit-summary-lifecycle').readNativeDecomposedParentFacts {
    assert.equal(typeof nativeParentApi.readNativeDecomposedParentFacts, 'function', 'native parent fact reader must exist');
    return nativeParentApi.readNativeDecomposedParentFacts;
}

import {
    fs,
    path,
    buildTaskAuditSummary,
    writeEvent,
    writePreflight,
    writeWorkflowConfig,
    writeActiveCompletionLock,
    makeTempDir} from './task-audit-summary-fixtures';


describe('gates/task-audit-summary', () => {
    let tmpDir: string;
    let eventsDir: string;
    let reviewsDir: string;
    const TASK_ID = 'T-AUDIT-1';

    beforeEach(() => {
        tmpDir = makeTempDir();
        eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });
        writeWorkflowConfig(tmpDir, false);
    });

    afterEach(() => {
        mock.restoreAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function aggregateProof() {
        const child = TASK_ID + '-1';
        fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
            '## Active Queue', '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
            `| ${TASK_ID} | DONE | P1 | audit | parent | test | 2026-10-16 | balanced | child tasks: ${child} |`,
            `| ${child} | DONE | P1 | audit | child | test | 2026-10-16 | balanced | Parent: ${TASK_ID}. |`
        ].join('\n') + '\n');
        const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
        const split = appendMandatoryTaskEvent(bundle, TASK_ID, 'STRICT_DECOMPOSITION_DECISION_RECORDED', 'INFO', 'Native aggregate caller fixture.', { decision: 'split-required' }).integrity;
        const completion = appendMandatoryTaskEvent(bundle, TASK_ID, 'DECOMPOSED_PARENT_COMPLETED', 'INFO', 'Native aggregate caller fixture.', {
            previous_status: 'DECOMPOSED', new_status: 'DONE', reason: 'explicit_children_done'
        }).integrity;
        assert.ok(split && completion);
        const requiredProofs = ['authenticated-decomposition', 'source-qualified-child-acceptance', 'preserved-parent-wip',
            'full-suite-composition', 'parent-memory-impact', 'historical-failure-resolution'];
        // The accepted resolver owns real signed source and original proof qualification; this fixture checks its audit consumer.
        const proof = { status: 'QUALIFIED', qualifiedProofs: requiredProofs, violations: [] as string[], native: {
            facts: { taskId: TASK_ID, taskStatus: 'DONE', childTaskIds: [child], historicalFailures: ['full-suite-validation'],
                decomposition: { taskId: TASK_ID, sequence: split.task_sequence, sha256: split.event_sha256 },
                completion: { taskId: TASK_ID, sequence: completion.task_sequence, sha256: completion.event_sha256 } },
            requirements: { status: 'REQUIRES_PROOF', requiredProofs, violations: [] },
            childSources: [{ taskId: child, artifactPath: path.join(reviewsDir, child + '-source.json'), artifactSha256: 'a'.repeat(64) }]
        } };
        mock.method(parentObligationApi, 'readNativeParentObligationProofs', () => proof);
        return proof;
    }

    it('audits a qualified native aggregate without inventing direct parent reviews', () => {
        aggregateProof();
        const timeline = fs.readFileSync(path.join(eventsDir, TASK_ID + '.jsonl'));
        const result = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot: tmpDir });
        assert.equal(result.status, 'PASS'); assert.equal(result.final_report_contract.status, 'READY');
        assert.equal(result.final_closeout.implementation_summary.path_mode, 'DECOMPOSED_PARENT');
        assert.deepEqual(result.final_closeout.implementation_summary.review_verdicts, {});
        assert.ok(result.gates.some(gate => gate.gate === 'decomposed-parent:preserved-parent-wip' && gate.status === 'PASS'));
        assert.ok(result.evidence.some(item => item.kind === 'child-source:' + TASK_ID + '-1'));
        assert.deepEqual(fs.readFileSync(path.join(eventsDir, TASK_ID + '.jsonl')), timeline);
    });

    for (const status of ['QUALIFIED', 'BLOCKED'] as const) it(`rejects alternate event and review roots for ${status === 'QUALIFIED' ? 'a qualified' : 'an unqualified'} native aggregate`, () => {
        const proof = aggregateProof();
        proof.status = status;
        if (status === 'BLOCKED') proof.violations = ['Original command coverage is unqualified.'];
        for (const root of ['eventsRoot', 'reviewsRoot'] as const) {
            const alternate = path.join(tmpDir, 'alternate-' + root);
            fs.mkdirSync(alternate);
            const result = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot: tmpDir, [root]: alternate });
            assert.equal(result.status, 'BLOCKED', root);
            assert.equal(result.final_report_contract.status, 'NOT_READY', root);
            assert.ok(result.blockers.some(blocker => blocker.gate === 'decomposed-parent-obligations'
                && blocker.reason === 'Native aggregate proof requires canonical event and review roots.'), root);
        }
    });

    it('retains exact unqualified original obligations in the aggregate audit', () => {
        const proof = aggregateProof(); proof.status = 'BLOCKED';
        for (const reason of ['Missing native child source.', 'Original command coverage differs.', 'Original WIP is unqualified.',
            'Original memory is stale.', 'Unresolved original historical failure.']) {
            proof.violations = [reason];
            const result = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot: tmpDir });
            assert.equal(result.status, 'BLOCKED'); assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.ok(result.blockers.some(blocker => blocker.reason === reason));
        }
    });

    it('preserves completion finality and timeline integrity for qualified aggregates', () => {
        aggregateProof();
        writeActiveCompletionLock(reviewsDir, TASK_ID);
        const inFlight = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot: tmpDir });
        assert.equal(inFlight.status, 'INCOMPLETE');
        assert.equal(inFlight.point_in_time_snapshot.status, 'FINALIZATION_IN_FLIGHT');
        assert.equal(inFlight.final_report_contract.status, 'NOT_READY');
        const timeline = path.join(eventsDir, TASK_ID + '.jsonl');
        fs.writeFileSync(timeline, fs.readFileSync(timeline, 'utf8').replace('explicit_children_done', 'changed'));
        const corrupt = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot: tmpDir });
        assert.equal(corrupt.status, 'BLOCKED'); assert.ok(corrupt.blockers.some(blocker => blocker.gate === 'integrity'));
    });

    it('selects native parent facts without granting aggregate acceptance', () => {
        const read = nativeParentReader(), children = [TASK_ID + '-1', TASK_ID + '-2'];
        const queue = (ids: string[], notes = 'child tasks: ' + children.join(', ')) => {
            fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
                '## Active Queue',
                '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                `| ${TASK_ID} | DONE | P1 | audit | parent audit | test | 2026-10-16 | balanced | ${notes} |`,
                ...ids.map(id => `| ${id} | DONE | P1 | audit | child | test | 2026-10-16 | balanced | Parent: ${TASK_ID}. |`)
            ].join('\n') + '\n');
        };
        queue(children);
        const artifact = buildStrictDecompositionDecisionArtifact({ taskId: TASK_ID, decision: 'split-required',
            taskProfile: 'balanced', taskSummary: 'parent audit', reason: 'Two bounded native consumer scopes.',
            scopeRisk: 'Source and audit evidence must remain bound.', expectedReviewTypes: ['none'],
            atomicityConstraints: ['Native source selection precedes audit consumption.'], proposedChildTaskIds: children,
            workPackageContract: { schema_version: 2, finding_obligations: [], work_packages: children.map((id, i) => ({
                task_id: id, profile: 'balanced', root_cause_area: 'native-parent-part-' + i,
                objective: 'Validate a bounded native parent audit component.', scope_obligations: ['Only its bounded current source scope.'],
                validation_contract: ['Current native validation remains required.'], finding_obligation_ids: [], required_review_types: []
            })) } });
        const artifactPath = path.join(reviewsDir, TASK_ID + '-strict-decomposition-decision.json');
        fs.writeFileSync(artifactPath, JSON.stringify(artifact));
        const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
        const decomposition = { artifact_path: artifactPath.replace(/\\/gu, '/'), decision: artifact.decision,
            task_profile: artifact.task_profile, task_summary_sha256: artifact.task_summary_sha256,
            proposed_child_task_ids: children, work_package_contract_sha256: artifact.work_package_contract_sha256 };
        const add = (type: string, details: object = {}, outcome: 'INFO' | 'PASS' | 'FAIL' = 'INFO') =>
            appendMandatoryTaskEvent(bundle, TASK_ID, type, outcome, 'Isolated native parent fixture.', details, { actor: 'orchestrator' });
        add('STRICT_DECOMPOSITION_DECISION_RECORDED', decomposition);
        add('FULL_SUITE_VALIDATION_FAILED', {}, 'FAIL');
        add('DECOMPOSED_PARENT_COMPLETED', { previous_status: 'DECOMPOSED', new_status: 'DONE', reason: 'explicit_children_done' });
        const calls: string[] = [];
        // This unit checks selection; the existing proof-reader suite owns real signed Git acceptance.
        mock.method(nativeChildApi, 'readNativeChildSourceAcceptance', (_root: string, id: string) => {
            calls.push(id);
            return { taskId: id, commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), parentCommitSha: null,
                artifactPath: id + '-source.json', artifactSha256: 'c'.repeat(64), postCommitAudit: {} };
        });
        const timeline = fs.readFileSync(path.join(eventsDir, TASK_ID + '.jsonl'));
        const result = read(tmpDir, TASK_ID)!;
        assert.equal(result.requirements.status, 'REQUIRES_PROOF');
        assert.deepEqual(result.facts.childTaskIds, children);
        assert.deepEqual(calls, children);
        assert.equal(result.childSources.length, 2);
        assert.ok(result.facts.completion!.sequence > result.facts.decomposition!.sequence);
        assert.ok(result.requirements.requiredProofs.includes('full-suite-composition'));
        assert.ok(result.requirements.requiredProofs.includes('parent-memory-impact'));
        assert.ok(result.requirements.requiredProofs.includes('preserved-parent-wip'));
        assert.ok(result.requirements.historicalFailures.includes('full-suite-validation'));
        assert.equal('parentPass' in result, false);
        assert.deepEqual(fs.readFileSync(path.join(eventsDir, TASK_ID + '.jsonl')), timeline);
        fs.unlinkSync(path.join(eventsDir, TASK_ID + '.jsonl'));
        add('STRICT_DECOMPOSITION_DECISION_RECORDED', decomposition);
        add('FULL_SUITE_VALIDATION_PASSED', {}, 'PASS');
        add('FULL_SUITE_VALIDATION_SKIPPED');
        add('DECOMPOSED_PARENT_COMPLETED', { previous_status: 'DECOMPOSED', new_status: 'DONE', reason: 'explicit_children_done' });
        const skippedLater = read(tmpDir, TASK_ID)!;
        assert.equal(skippedLater.requirements.status, 'REQUIRES_PROOF');
        assert.ok(skippedLater.requirements.requiredProofs.includes('full-suite-composition'), 'a later skip cannot erase an original parent suite obligation');
        fs.writeFileSync(path.join(eventsDir, TASK_ID + '.jsonl'), timeline);
        queue([children[0]]);
        assert.equal(read(tmpDir, TASK_ID)!.requirements.status, 'BLOCKED');
        queue(children);
        fs.unlinkSync(path.join(eventsDir, TASK_ID + '.jsonl'));
        add('STRICT_DECOMPOSITION_DECISION_RECORDED', decomposition);
        add('DECOMPOSED_PARENT_COMPLETED', { previous_status: 'DECOMPOSED', new_status: 'DONE', reason: 'changed' });
        calls.length = 0;
        const invalidCompletion = read(tmpDir, TASK_ID)!;
        assert.equal(invalidCompletion.requirements.status, 'BLOCKED');
        assert.match(invalidCompletion.requirements.violations.join(' '), /Native decomposition, completion and explicit child graph do not match/u);
        assert.equal(calls.length, 0);
        fs.writeFileSync(path.join(eventsDir, TASK_ID + '.jsonl'), timeline.toString().replace('explicit_children_done', 'changed'));
        calls.length = 0;
        assert.equal(read(tmpDir, TASK_ID)!.requirements.status, 'BLOCKED');
        assert.equal(calls.length, 0);
        fs.writeFileSync(path.join(eventsDir, TASK_ID + '.jsonl'), timeline);
        mock.method(nativeChildApi, 'readNativeChildSourceAcceptance', () => { throw new Error('Missing native source acceptance.'); });
        assert.match(read(tmpDir, TASK_ID)!.requirements.violations.join(' '), /Missing native source acceptance/u);
        queue([], 'ordinary leaf');
        assert.equal(read(tmpDir, TASK_ID)!.requirements.status, 'BLOCKED');
        fs.unlinkSync(path.join(eventsDir, TASK_ID + '.jsonl'));
        assert.equal(read(tmpDir, TASK_ID), null);
        const followUps = [TASK_ID + '-F1'];
        queue(followUps, 'Review follow-up tasks materialized: ' + followUps.join(', '));
        assert.equal(read(tmpDir, TASK_ID), null, 'follow-up links alone do not turn an ordinary completed leaf into a native decomposed parent');
        add('STRICT_DECOMPOSITION_DECISION_RECORDED', decomposition);
        const splitOnly = fs.readFileSync(path.join(eventsDir, TASK_ID + '.jsonl'), 'utf8');
        fs.writeFileSync(path.join(eventsDir, TASK_ID + '.jsonl'), splitOnly.replace('split-required', 'atomic'));
        assert.equal(read(tmpDir, TASK_ID)?.requirements.status, 'BLOCKED', 'corrupt split-only history must not take the ordinary leaf branch');
    });

    describe('buildTaskAuditSummary', () => {
        it('marks final report contract as NOT_READY before completion passes cleanly', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: false }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.ok(result.final_report_contract.blocker?.includes('Completion gate has not passed'));
        });

        it('returns BLOCKED when a gate has FAIL outcome', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Compile failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            assert.ok(result.blockers.some(b => b.gate === 'compile-gate'));
        });

        it('detects REVIEW_GATE_PASSED as required-reviews-check pass', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review gate passed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const reviewGate = result.gates.find(g => g.gate === 'required-reviews-check');
            assert.ok(reviewGate);
            assert.equal(reviewGate.status, 'PASS');
        });

        it('detects REVIEW_GATE_PASSED_WITH_OVERRIDE as pass', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_PASSED_WITH_OVERRIDE',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Review gate passed with override.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const reviewGate = result.gates.find(g => g.gate === 'required-reviews-check');
            assert.ok(reviewGate);
            assert.equal(reviewGate.status, 'PASS');
        });

        it('detects DOC_IMPACT_ASSESSED as doc-impact-gate pass', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'DOC_IMPACT_ASSESSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Doc impact assessed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const docGate = result.gates.find(g => g.gate === 'doc-impact-gate');
            assert.ok(docGate);
            assert.equal(docGate.status, 'PASS');
        });

        it('detects REVIEW_GATE_FAILED as required-reviews-check failure', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'REVIEW_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Review gate failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const reviewGate = result.gates.find(g => g.gate === 'required-reviews-check');
            assert.ok(reviewGate);
            assert.equal(reviewGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'required-reviews-check'));
        });

        it('detects RULE_PACK_LOAD_FAILED as load-rule-pack failure', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'RULE_PACK_LOAD_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Rule pack load failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const rulePackGate = result.gates.find(g => g.gate === 'load-rule-pack');
            assert.ok(rulePackGate);
            assert.equal(rulePackGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'load-rule-pack'));
        });

        it('detects PREFLIGHT_FAILED as classify-change failure', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'PREFLIGHT_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Preflight failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const classifyGate = result.gates.find(g => g.gate === 'classify-change');
            assert.ok(classifyGate);
            assert.equal(classifyGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'classify-change'));
        });

        it('detects DOC_IMPACT_ASSESSMENT_FAILED as doc-impact-gate failure', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'DOC_IMPACT_ASSESSMENT_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Doc impact assessment failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const docGate = result.gates.find(g => g.gate === 'doc-impact-gate');
            assert.ok(docGate);
            assert.equal(docGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'doc-impact-gate'));
        });

        it('detects COMPLETION_GATE_FAILED as completion-gate failure', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Completion gate failed.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const completionGate = result.gates.find(g => g.gate === 'completion-gate');
            assert.ok(completionGate);
            assert.equal(completionGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'completion-gate'));
        });

        it('reports INCOMPLETE point-in-time snapshot when completion finalization is still in flight', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Older completion gate failed.'
            });
            const lockPath = writeActiveCompletionLock(reviewsDir, TASK_ID);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.point_in_time_snapshot.status, 'FINALIZATION_IN_FLIGHT');
            assert.equal(result.point_in_time_snapshot.gate, 'completion-gate');
            assert.equal(result.point_in_time_snapshot.lock_path, lockPath.replace(/\\/g, '/'));
            assert.equal(result.blockers.find((entry) => entry.gate === 'completion-gate'), undefined);
            assert.match(result.final_report_contract.blocker || '', /point-in-time snapshot/i);
            assert.match(result.final_report_contract.blocker || '', /Re-run task-audit-summary sequentially/i);
        });

        it('keeps BLOCKED when non-completion blockers remain during in-flight finalization', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Completion gate failed.'
            });
            writeActiveCompletionLock(reviewsDir, TASK_ID);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/foo.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: { code: true }
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'BLOCKED');
            assert.equal(result.point_in_time_snapshot.status, 'FINALIZATION_IN_FLIGHT');
            assert.ok(result.blockers.some((entry) => entry.gate === 'code-review'));
        });

        it('degrades an older completion pass to INCOMPLETE while finalization remains in flight', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Older completion gate passed.'
            });
            const lockPath = writeActiveCompletionLock(reviewsDir, TASK_ID);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.point_in_time_snapshot.status, 'FINALIZATION_IN_FLIGHT');
            assert.equal(result.point_in_time_snapshot.lock_path, lockPath.replace(/\\/g, '/'));
            assert.equal(result.point_in_time_snapshot.owner_pid, process.pid);
            assert.equal(result.point_in_time_snapshot.owner_metadata_status, 'ok');
            assert.equal(result.point_in_time_snapshot.acquisition_policy?.timeout_ms, 5000);
            assert.equal(result.final_report_contract.status, 'NOT_READY');
            assert.match(result.final_report_contract.blocker || '', /point-in-time snapshot/i);
        });

        it('treats stale finalization lock metadata as a point-in-time snapshot for an older completion pass', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'COMPLETION_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Older completion gate passed.'
            });
            const lockPath = writeActiveCompletionLock(reviewsDir, TASK_ID);
            fs.rmSync(path.join(lockPath, 'owner.json'), { force: true });
            const staleTime = new Date(Date.now() - 60_000);
            fs.utimesSync(lockPath, staleTime, staleTime);

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.status, 'INCOMPLETE');
            assert.equal(result.point_in_time_snapshot.status, 'FINALIZATION_IN_FLIGHT');
            assert.match(result.point_in_time_snapshot.message || '', /Completion finalization lock is stale/i);
            assert.equal(result.point_in_time_snapshot.owner_metadata_status, 'missing');
            assert.equal(result.point_in_time_snapshot.stale_reason, 'owner_dead');
            assert.match(result.final_report_contract.blocker || '', /doctor --cleanup-stale-locks does not reclaim completion finalization locks/i);
        });

        it('handles missing events file gracefully', () => {
            // No events file created at all
            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.events_count, 0);
            assert.equal(result.integrity_status, 'MISSING');
            assert.equal(result.status, 'INCOMPLETE');
        });

        it('handles malformed JSON in events file', () => {
            const eventsFile = path.join(eventsDir, `${TASK_ID}.jsonl`);
            fs.writeFileSync(eventsFile, 'not valid json\n{"valid":true}\n{broken\n', 'utf8');

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            // Should parse the one valid line
            assert.equal(result.events_count, 1);
        });

        it('handles malformed preflight JSON gracefully', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            fs.writeFileSync(
                path.join(reviewsDir, `${TASK_ID}-preflight.json`),
                'not valid json',
                'utf8'
            );

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.changed_files, []);
            assert.equal(result.changed_files_count, 0);
        });

        it('detects HANDSHAKE_DIAGNOSTICS_RECORDED pass event', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Handshake diagnostics recorded.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const gate = result.gates.find(g => g.gate === 'handshake-diagnostics');
            assert.ok(gate);
            assert.equal(gate.status, 'PASS');
        });

        it('detects SHELL_SMOKE_PREFLIGHT_RECORDED pass event', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Shell smoke recorded.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const gate = result.gates.find(g => g.gate === 'shell-smoke-preflight');
            assert.ok(gate);
            assert.equal(gate.status, 'PASS');
        });

        it('detects PREFLIGHT_CLASSIFIED as classify-change pass', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'PREFLIGHT_CLASSIFIED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Preflight classified.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const gate = result.gates.find(g => g.gate === 'classify-change');
            assert.ok(gate);
            assert.equal(gate.status, 'PASS');
        });

        it('detects REVIEW_PHASE_STARTED pass event', () => {
            const now = new Date().toISOString();
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: now,
                task_id: TASK_ID,
                event_type: 'REVIEW_PHASE_STARTED',
                outcome: 'INFO',
                actor: 'gate',
                message: 'Review phase started.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const gate = result.gates.find(g => g.gate === 'review-phase');
            assert.ok(gate);
            assert.equal(gate.status, 'PASS');
        });

        it('uses latest event when both pass and fail exist for a gate', () => {
            const early = '2026-01-01T00:00:00.000Z';
            const late = '2026-01-01T00:01:00.000Z';

            // Early pass, later fail
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: early,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile passed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: late,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Compile failed on rerun.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const compileGate = result.gates.find(g => g.gate === 'compile-gate');
            assert.ok(compileGate);
            assert.equal(compileGate.status, 'FAIL');
            assert.ok(result.blockers.some(b => b.gate === 'compile-gate'));
        });

        it('uses latest pass when fail precedes pass', () => {
            const early = '2026-01-01T00:00:00.000Z';
            const late = '2026-01-01T00:01:00.000Z';

            // Early fail, later pass (successful rerun)
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: early,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_FAILED',
                outcome: 'FAIL',
                actor: 'gate',
                message: 'Compile failed.'
            });
            writeEvent(eventsDir, TASK_ID, {
                timestamp_utc: late,
                task_id: TASK_ID,
                event_type: 'COMPILE_GATE_PASSED',
                outcome: 'PASS',
                actor: 'gate',
                message: 'Compile passed on rerun.'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            const compileGate = result.gates.find(g => g.gate === 'compile-gate');
            assert.ok(compileGate);
            assert.equal(compileGate.status, 'PASS');
            assert.ok(!result.blockers.some(b => b.gate === 'compile-gate'));
        });
    });
});
