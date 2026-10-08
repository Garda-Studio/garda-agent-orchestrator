import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
    runClassifyChangeCommand,
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runRecordNoOpCommand,
    runShellSmokePreflightCommand
} from '../../../../../../src/cli/commands/gates';
import { appendTaskEvent, inspectTaskEventFile } from '../../../../../../src/gate-runtime/task-events';
import { fileSha256 } from '../../../../../../src/gates/shared/helpers';
import { getCurrentNoOpEventSha256, getNoOpEvidence } from '../../../../../../src/gates/task-mode/no-op';
import { initGitRepo } from '../../../../gates/git-fixtures';
import {
    makeTempRepo,
    reviewsRoot,
    TASK_ID
} from '../../../../gates/next-step/next-step-completion-fixtures';
import { resolveNextStep } from '../../../../gates/next-step/next-step-test-support';

const RULE_FILES = [
    '00-core.md', '15-project-memory.md', '30-code-style.md', '35-strict-coding-rules.md',
    '40-commands.md', '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md',
    '90-skill-catalog.md'
];
const REASON = 'The requested source behavior already matches the committed implementation.';

function resolveSourceCliPath(): string {
    let current = path.resolve(__dirname);
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'bin/garda.js'))) {
            return path.join(current, 'bin/garda.js');
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve the source CLI for the native fixture launcher.');
}

function createFixture() {
    const repoRoot = makeTempRepo();
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Codex fixture\n');
    fs.mkdirSync(path.join(repoRoot, '.agents/workflows'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.agents/workflows/start-task.md'), '# Start task fixture\n');
    fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator/VERSION'), '1.4.4\n');
    const fixtureCliPath = path.join(repoRoot, 'garda-agent-orchestrator/bin/garda.js');
    fs.mkdirSync(path.dirname(fixtureCliPath), { recursive: true });
    fs.writeFileSync(fixtureCliPath, `const { main } = require(${JSON.stringify(resolveSourceCliPath())});\nvoid main();\n`);
    initGitRepo(repoRoot, { gitignoreContent: 'TASK.md\ngarda-agent-orchestrator/runtime/\n' });
    function startCycle(upgradeExistingTaskMode = false) {
        const entry = runEnterTaskModeCommand({
            repoRoot, taskId: TASK_ID, taskSummary: 'Audit the already implemented source behavior',
            provider: 'Codex', requestedDepth: 2, startBanner: 'Garda task workflow engaged.',
            plannedChangedFiles: ['src/app.ts'], upgradeExistingTaskMode, emitMetrics: false
        });
        assert.equal(entry.exitCode, 0, entry.outputLines.join('\n'));
        const rules = runLoadRulePackCommand({
            repoRoot, taskId: TASK_ID, stage: 'TASK_ENTRY', loadedRuleFiles: RULE_FILES, emitMetrics: false
        });
        assert.equal(rules.exitCode, 0, rules.outputLines.join('\n'));
        const handshake = runHandshakeDiagnosticsCommand({ repoRoot, taskId: TASK_ID, emitMetrics: false });
        assert.equal(handshake.exitCode, 0, handshake.outputLines.join('\n'));
        const smoke = runShellSmokePreflightCommand({ repoRoot, taskId: TASK_ID, emitMetrics: false });
        assert.equal(smoke.exitCode, 0, smoke.outputLines.join('\n'));
    }
    startCycle();
    const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
    const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const timelinePath = path.join(bundleRoot, 'runtime/task-events', `${TASK_ID}.jsonl`);
    const noOpPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-no-op.json`);
    const metricsPath = path.join(bundleRoot, 'runtime/metrics.jsonl');
    function classify(outputPath = preflightPath) {
        const result = runClassifyChangeCommand({
            repoRoot, taskId: TASK_ID, taskIntent: 'Audit the already implemented source behavior',
            changedFiles: ['src/app.ts'], outputPath, emitMetrics: false
        });
        assert.equal(JSON.parse(fs.readFileSync(outputPath, 'utf8')).task_id, TASK_ID, result.outputText);
        const rules = runLoadRulePackCommand({
            repoRoot, taskId: TASK_ID, stage: 'POST_PREFLIGHT', preflightPath: outputPath,
            loadedRuleFiles: RULE_FILES, emitMetrics: false
        });
        assert.equal(rules.exitCode, 0, rules.outputLines.join('\n'));
        return outputPath;
    }
    classify();
    function record(preflight: string | undefined = undefined, publication: {
        artifactPath?: string;
        metricsPath?: string;
        emitMetrics?: boolean;
    } = {}) {
        return runRecordNoOpCommand({
            repoRoot, taskId: TASK_ID, preflightPath: preflight,
            classification: 'NO_CHANGES_REQUIRED', reason: REASON, emitMetrics: false,
            ...publication
        });
    }
    function editPreflight(edit: (value: Record<string, unknown>) => void) {
        const value = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        edit(value);
        fs.writeFileSync(preflightPath, `${JSON.stringify(value, null, 2)}\n`);
    }
    function publicationState() {
        return [noOpPath, timelinePath, metricsPath].map((file) => fs.existsSync(file) ? fs.readFileSync(file) : null);
    }
    return { repoRoot, preflightPath, bundleRoot, timelinePath, noOpPath, startCycle, classify, record, editPreflight, publicationState };
}

describe('record-no-op current preflight admission', () => {
    for (const explicit of [true, false]) {
        it(`publishes a usable authenticated binding with ${explicit ? 'explicit' : 'resolved'} preflight`, () => {
            const fixture = createFixture();
            const result = fixture.record(explicit ? fixture.preflightPath : undefined);
            assert.equal(result.exitCode, 0);
            const evidence = getNoOpEvidence(fixture.repoRoot, TASK_ID, '', fixture.preflightPath);
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.preflight_sha256, fileSha256(fixture.preflightPath));
            assert.ok(getCurrentNoOpEventSha256(fixture.repoRoot, TASK_ID, evidence));
            assert.match(inspectTaskEventFile(fixture.timelinePath, TASK_ID).status, /^PASS/u);
            const next = resolveNextStep({ taskId: TASK_ID, repoRoot: fixture.repoRoot });
            assert.equal(next.next_gate, 'build-review-context', next.reason);
            assert.ok(next.review.required_reviews.includes('code'));
            assert.doesNotMatch(next.reason, /EVIDENCE_PREFLIGHT_PATH_MISSING/u);
        });
    }

    it('resolves the latest classified custom path rather than guessing the default artifact', () => {
        const fixture = createFixture();
        const current = fixture.classify(path.join(reviewsRoot(fixture.repoRoot), 'current-audit-preflight.json'));
        assert.equal(fixture.record().exitCode, 0);
        const evidence = getNoOpEvidence(fixture.repoRoot, TASK_ID, '', current);
        assert.equal(evidence.evidence_status, 'PASS');
        assert.ok(getCurrentNoOpEventSha256(fixture.repoRoot, TASK_ID, evidence));
    });

    it('publishes a contained custom artifact and independent enabled metrics', () => {
        const fixture = createFixture();
        const artifactPath = path.join(reviewsRoot(fixture.repoRoot), 'custom/no-op.json');
        const metricsPath = path.join(reviewsRoot(fixture.repoRoot), 'custom/metrics.jsonl');
        const result = fixture.record(undefined, { artifactPath, metricsPath, emitMetrics: true });
        assert.equal(result.exitCode, 0);
        const evidence = getNoOpEvidence(fixture.repoRoot, TASK_ID, artifactPath, fixture.preflightPath);
        assert.equal(evidence.evidence_status, 'PASS');
        assert.ok(getCurrentNoOpEventSha256(fixture.repoRoot, TASK_ID, evidence));
        const metrics = fs.readFileSync(metricsPath, 'utf8').trim().split(/\r?\n/u)
            .map((line) => JSON.parse(line));
        const recorded = metrics.find((event) => event.event_type === 'no_op_recorded');
        assert.ok(recorded);
        assert.equal(recorded.task_id, TASK_ID);
        assert.equal(recorded.preflight_sha256, fileSha256(fixture.preflightPath));
    });

    it('rejects a missing automatically resolved artifact before publishing', () => {
        const fixture = createFixture();
        fs.unlinkSync(fixture.preflightPath);
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(undefined), /preflight|zero.diff|scope|binding|cycle/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects an unclassified copied preflight instead of treating its bytes as authority', () => {
        const fixture = createFixture();
        const copied = path.join(reviewsRoot(fixture.repoRoot), 'copied-preflight.json');
        fs.copyFileSync(fixture.preflightPath, copied);
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(copied), /preflight|zero.diff|scope|binding|cycle/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects a distinct case-only copied preflight', (context) => {
        const fixture = createFixture();
        const current = fixture.classify(path.join(reviewsRoot(fixture.repoRoot), 'Audit-preflight.json'));
        const copied = path.join(reviewsRoot(fixture.repoRoot), 'audit-preflight.json');
        fs.writeFileSync(copied, fs.readFileSync(current));
        if (fs.realpathSync.native(current) === fs.realpathSync.native(copied)) {
            context.skip('The filesystem aliases case-only filenames; this case requires distinct files.');
            return;
        }
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(copied), /latest native classification/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects artifact output that replaces the admitted preflight', () => {
        const fixture = createFixture();
        const preflightBytes = fs.readFileSync(fixture.preflightPath);
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(undefined, { artifactPath: fixture.preflightPath }), /publication.*distinct|preflight.*output/iu);
        assert.deepEqual(fs.readFileSync(fixture.preflightPath), preflightBytes);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects metrics output that replaces the admitted preflight', () => {
        const fixture = createFixture();
        const preflightBytes = fs.readFileSync(fixture.preflightPath);
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(undefined, {
            metricsPath: fixture.preflightPath, emitMetrics: true
        }), /publication.*distinct|preflight.*output/iu);
        assert.deepEqual(fs.readFileSync(fixture.preflightPath), preflightBytes);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects metrics output that corrupts the no-op artifact', () => {
        const fixture = createFixture();
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(undefined, {
            metricsPath: fixture.noOpPath, emitMetrics: true
        }), /publication.*distinct/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects a metrics hard link to the admitted preflight', () => {
        const fixture = createFixture();
        const linked = path.join(reviewsRoot(fixture.repoRoot), 'preflight-metrics-alias.jsonl');
        fs.linkSync(fixture.preflightPath, linked);
        const preflightBytes = fs.readFileSync(fixture.preflightPath);
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(undefined, { metricsPath: linked, emitMetrics: true }), /publication.*distinct/iu);
        assert.deepEqual(fs.readFileSync(fixture.preflightPath), preflightBytes);
        assert.deepEqual(fs.readFileSync(linked), preflightBytes);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects a foreign task before publishing', () => {
        const fixture = createFixture();
        fixture.editPreflight((value) => { value.task_id = 'T-FOREIGN-1'; });
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /task|preflight/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('requires a preflight task identity', () => {
        const fixture = createFixture();
        fixture.editPreflight((value) => { delete value.task_id; });
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /task|preflight/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects a preflight from the previous task cycle', () => {
        const fixture = createFixture();
        fixture.startCycle(true);
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /preflight|zero.diff|scope|binding|cycle/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects an older explicit path after a newer native classification', () => {
        const fixture = createFixture();
        fixture.classify(path.join(reviewsRoot(fixture.repoRoot), 'newer-preflight.json'));
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /preflight|zero.diff|scope|binding|cycle/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects preflight payload hash drift after authenticated rule binding', () => {
        const fixture = createFixture();
        fixture.editPreflight((value) => { value.mode = 'FAST_PATH'; });
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /preflight|zero.diff|scope|binding|cycle/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects a failed classification after the last successful preflight', () => {
        const fixture = createFixture();
        appendTaskEvent(fixture.bundleRoot, TASK_ID, 'PREFLIGHT_FAILED', 'FAIL', 'Classification failed.', {});
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /preflight|zero.diff|scope|binding|cycle/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects an unfinished native classification before publication', () => {
        const fixture = createFixture();
        appendTaskEvent(fixture.bundleRoot, TASK_ID, 'PREFLIGHT_STARTED', 'INFO', 'Begin a new classification.', {});
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /unfinished classification/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects a tampered task timeline instead of trusting its preflight path', () => {
        const fixture = createFixture();
        fs.appendFileSync(fixture.timelinePath, '{}\n');
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /authenticated native task timeline/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects malformed zero-diff metadata rather than defaulting it to zero', () => {
        const fixture = createFixture();
        fixture.editPreflight((value) => { value.metrics = {}; delete value.changed_files; });
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /preflight|zero.diff|scope|binding|cycle/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects newly introduced source changes after the zero-diff classification', () => {
        const fixture = createFixture();
        fs.appendFileSync(path.join(fixture.repoRoot, 'src/app.ts'), 'export const changed = 2;\n');
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /preflight|zero.diff|scope|binding|cycle/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('rejects a genuinely nonempty native preflight before publication', () => {
        const fixture = createFixture();
        fs.appendFileSync(path.join(fixture.repoRoot, 'src/app.ts'), 'export const changed = 2;\n');
        fixture.classify();
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /preflight|zero.diff|scope|binding|cycle/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });

    it('retains artifact bytes and event count on a rejected replacement', () => {
        const fixture = createFixture();
        assert.equal(fixture.record(fixture.preflightPath).exitCode, 0);
        fixture.editPreflight((value) => { value.task_id = 'T-FOREIGN-1'; });
        const before = fixture.publicationState();
        assert.throws(() => fixture.record(fixture.preflightPath), /task|preflight/iu);
        assert.deepEqual(fixture.publicationState(), before);
    });
});
