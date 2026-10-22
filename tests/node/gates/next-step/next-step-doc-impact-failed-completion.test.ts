import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initGitRepo } from '../git-fixtures';
import { resolveNextStep } from './next-step-test-support';
import {
    buildStaleCompletionFailureDocCloseoutAllowance
} from '../../../../src/gates/next-step/next-step-doc-closeout-readiness';
import {
    TASK_ID,
    ALL_REVIEW_FLAGS,
    makeTempRepo,
    reviewsRoot,
    writeJson,
    fileSha256,
    appendEvent,
    seedStartedTask,
    writePreflight,
    seedCompilePass,
    writeGitAutoPreflight,
    seedGitAutoCompilePass,
    stageFiles,
    writeStagedPreflight,
    seedStagedCompilePass,
    writeReviewEvidence,
    seedReviewGatePass} from './next-step-doc-impact-fixtures';

describe('gates/next-step', () => {
    it('keeps changelog-only closeout in doc-impact lane after failed completion', () => {

        const repoRoot = makeTempRepo();

        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        writeReviewEvidence(repoRoot, TASK_ID, 'test');

        seedReviewGatePass(repoRoot, TASK_ID);

        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', {

            reason: 'Completion failed before changelog closeout was recorded.'

        });

        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Documented reviewed behavior.\n', 'utf8');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'doc-impact-gate');

        assert.ok(!result.commands[0].command.includes('gate classify-change'));

        assert.ok(result.commands[0].command.includes('--decision "DOCS_UPDATED"'));

        assert.ok(result.commands[0].command.includes('--docs-updated "CHANGELOG.md"'));

        assert.ok(result.reason.includes('Completion requires an explicit docs decision.'));

    });



    it('materializes review reuse before continuing a refreshed changelog-only preflight', () => {

        const repoRoot = makeTempRepo();

        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        writeReviewEvidence(repoRoot, TASK_ID, 'test');

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Documented reviewed behavior.\n', 'utf8');



        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'build-review-context', result.reason);

        assert.ok(result.commands[0].command.includes('build-review-context'));

        assert.ok(!result.commands[0].command.includes('gate compile-gate'));

        assert.ok(result.reason.includes('without launching a fresh reviewer'));

    });



    it('materializes review reuse before continuing a refreshed staged ordinary-doc preflight', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json'), {

            ordinary_doc_paths: ['BACKLOG']

        });

        fs.writeFileSync(path.join(repoRoot, 'BACKLOG'), 'Pending release note\n', 'utf8');

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');

        stageFiles(repoRoot, 'src/app.ts');

        seedStartedTask(repoRoot, TASK_ID);

        writeStagedPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        seedStagedCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        writeReviewEvidence(repoRoot, TASK_ID, 'test');

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.appendFileSync(path.join(repoRoot, 'BACKLOG'), 'Documented reviewed behavior.\n', 'utf8');

        stageFiles(repoRoot, 'BACKLOG');



        writeStagedPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'build-review-context', result.reason);

        assert.ok(result.commands[0].command.includes('build-review-context'));

        assert.ok(!result.commands[0].command.includes('gate compile-gate'));

        assert.ok(result.reason.includes('without launching a fresh reviewer'));

    });



    it('keeps ordinary docs-only closeout in doc-impact lane after failed completion', () => {

        const repoRoot = makeTempRepo();

        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });

        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI reference\n', 'utf8');

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedReviewGatePass(repoRoot, TASK_ID);

        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', {

            reason: 'Completion failed before docs closeout was recorded.'

        });

        fs.appendFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '\nDocumented reviewed CLI behavior.\n', 'utf8');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'doc-impact-gate');

        assert.ok(!result.commands[0].command.includes('gate classify-change'));

        assert.ok(result.commands[0].command.includes('--decision "DOCS_UPDATED"'));

        assert.ok(result.commands[0].command.includes('--docs-updated "docs/cli-reference.md"'));

        assert.ok(result.commands[0].command.includes('--changelog-updated false'));

    });



    it('routes repaired ordinary docs doc-impact to completion after failed completion without preflight refresh', () => {

        const repoRoot = makeTempRepo();

        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });

        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI reference\n', 'utf8');

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.appendFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '\nDocumented reviewed CLI behavior.\n', 'utf8');

        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', {

            reason: 'Completion failed before the repaired doc-impact closeout was retried.'

        });

        const docImpact = {

            task_id: TASK_ID,

            decision: 'DOCS_UPDATED',

            status: 'PASSED',

            outcome: 'PASS',

            preflight_path: preflightPath,

            preflight_hash_sha256: fileSha256(preflightPath),

            docs_updated: ['docs/cli-reference.md'],

            behavior_changed: false,

            changelog_updated: false

        };

        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`), docImpact);

        appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', docImpact);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'completion-gate');

        assert.ok(result.commands[0].command.includes('gate completion-gate'));

        assert.ok(!result.commands[0].command.includes('gate classify-change'));

    });



    it('routes stale docs-only doc-impact evidence after failed completion back to preflight refresh', () => {

        const repoRoot = makeTempRepo();

        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });

        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI reference\n', 'utf8');

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.appendFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '\nDocumented reviewed CLI behavior.\n', 'utf8');

        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', {

            reason: 'Completion failed after stale doc-impact evidence.'

        });

        const docImpact = {

            task_id: TASK_ID,

            decision: 'DOCS_UPDATED',

            status: 'PASSED',

            outcome: 'PASS',

            preflight_path: preflightPath,

            preflight_hash_sha256: 'stale-preflight-hash',

            docs_updated: ['docs/cli-reference.md'],

            behavior_changed: false,

            changelog_updated: false

        };

        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`), docImpact);

        appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', docImpact);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'classify-change');

        assert.ok(result.reason.includes('Preflight evidence is older than the latest COMPLETION_GATE_FAILED'));

    });



    it('routes invalid doc-impact bindings after failed completion back to preflight refresh', () => {
        const repoRoot = makeTempRepo();
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI reference\n', 'utf8');
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedReviewGatePass(repoRoot, TASK_ID);
        fs.appendFileSync(
            path.join(repoRoot, 'docs', 'cli-reference.md'),
            '\nDocumented reviewed CLI behavior.\n',
            'utf8'
        );
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL', {
            reason: 'Completion failed before repaired doc-impact binding was validated.'
        });
        const baseDocImpact = {
            task_id: TASK_ID,
            decision: 'DOCS_UPDATED',
            status: 'PASSED',
            outcome: 'PASS',
            preflight_path: preflightPath,
            preflight_hash_sha256: fileSha256(preflightPath),
            docs_updated: ['docs/cli-reference.md'],
            behavior_changed: false,
            changelog_updated: false
        };
        const timelinePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'task-events',
            `${TASK_ID}.jsonl`
        );
        const canonicalTimeline = fs.readFileSync(timelinePath);
        const eventsRoot = path.dirname(timelinePath);
        const preflightSha256 = fileSha256(preflightPath);
        const docImpactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`);
        const scenarios: Array<{
            name: string;
            mutateArtifact: (artifact: Record<string, unknown>) => Record<string, unknown>;
            appendEvents: (artifact: Record<string, unknown>) => void;
        }> = [
            {
                name: 'mismatched doc-impact task id',
                mutateArtifact: (artifact: Record<string, unknown>) => ({ ...artifact, task_id: 'T-999' }),
                appendEvents: (artifact: Record<string, unknown>) => {
                    appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', artifact);
                }
            },
            {
                name: 'mismatched doc-impact preflight path',
                mutateArtifact: (artifact: Record<string, unknown>) => ({
                    ...artifact,
                    preflight_path: 'garda-agent-orchestrator/runtime/reviews/T-999-preflight.json'
                }),
                appendEvents: (artifact: Record<string, unknown>) => {
                    appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', artifact);
                }
            },
            {
                name: 'missing matching DOC_IMPACT_ASSESSED details',
                mutateArtifact: (artifact: Record<string, unknown>) => artifact,
                appendEvents: () => {
                    appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', {});
                }
            },
            {
                name: 'mismatched doc-impact changelog flag',
                mutateArtifact: (artifact: Record<string, unknown>) => artifact,
                appendEvents: (artifact: Record<string, unknown>) => {
                    appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', {
                        ...artifact,
                        changelog_updated: true
                    });
                }
            },
            {
                name: 'mismatched doc-impact project memory no-update-needed flag',
                mutateArtifact: (artifact: Record<string, unknown>) => artifact,
                appendEvents: (artifact: Record<string, unknown>) => {
                    appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', {
                        ...artifact,
                        project_memory_update_not_needed: true
                    });
                }
            },
            {
                name: 'behavior-changing doc-impact evidence',
                mutateArtifact: (artifact: Record<string, unknown>) => ({
                    ...artifact,
                    behavior_changed: true,
                    changelog_updated: true,
                    docs_updated: ['CHANGELOG.md', 'docs/cli-reference.md']
                }),
                appendEvents: (artifact: Record<string, unknown>) => {
                    appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', {
                        ...artifact,
                        behavior_changed: true,
                        changelog_updated: true,
                        docs_updated: ['CHANGELOG.md', 'docs/cli-reference.md']
                    });
                }
            },
            {
                name: 'newer stale doc-impact event',
                mutateArtifact: (artifact: Record<string, unknown>) => artifact,
                appendEvents: (artifact: Record<string, unknown>) => {
                    appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', artifact);
                    appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED', 'PASS', {
                        ...artifact,
                        preflight_hash_sha256: 'newer-stale-preflight-hash'
                    });
                }
            }
        ];

        for (const scenario of scenarios) {
            fs.writeFileSync(timelinePath, canonicalTimeline);
            writeJson(
                docImpactPath,
                scenario.mutateArtifact(baseDocImpact)
            );
            scenario.appendEvents(baseDocImpact);

            const allowance = buildStaleCompletionFailureDocCloseoutAllowance(
                repoRoot,
                eventsRoot,
                TASK_ID,
                preflightPath,
                preflightSha256,
                { ready: true, reason: 'The fixture workspace is current.' },
                docImpactPath
            );
            assert.notEqual(
                allowance.allowStaleCompletionFailureForDocCloseout,
                true,
                scenario.name
            );
            if (scenario.name !== 'mismatched doc-impact task id') {
                continue;
            }

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, 'classify-change', scenario.name);
            assert.ok(
                result.reason.includes('Preflight evidence is older than the latest COMPLETION_GATE_FAILED'),
                `${scenario.name}: ${result.reason}`
            );
        }
    });



    it('routes back to preflight when staged ordinary doc closeout is combined with source drift', () => {

        const repoRoot = makeTempRepo();

        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');

        stageFiles(repoRoot, 'src/app.ts');

        seedStartedTask(repoRoot, TASK_ID);

        writeStagedPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        seedStagedCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Documented staged reviewed behavior.\n', 'utf8');

        fs.writeFileSync(path.join(repoRoot, 'src', 'extra.ts'), 'export const extra = 3;\n', 'utf8');

        stageFiles(repoRoot, 'CHANGELOG.md', 'src/extra.ts');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'restart-coherent-cycle');

        assert.ok(result.reason.includes('src/extra.ts'));

        assert.ok(!result.commands[0].command.includes('gate doc-impact-gate'));

    });



    it('routes back to preflight when post-review docs delta touches protected control-plane docs', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.appendFileSync(

            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md'),

            '\nProtected workflow rule wording changed.\n',

            'utf8'

        );



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'load-rule-pack');

        assert.ok(result.reason.includes('stale or invalid'));

        assert.ok(result.reason.includes('garda-agent-orchestrator/live/docs/agent-rules/00-core.md'));

    });



    it('routes back to preflight when configured ordinary docs match config/dependency drift', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json'), {

            ordinary_doc_paths: ['package.json']

        });

        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'fixture' }, null, 2), 'utf8');

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.writeFileSync(

            path.join(repoRoot, 'package.json'),

            JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2),

            'utf8'

        );



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'restart-coherent-cycle');

        assert.ok(result.reason.includes('stale preflight'), result.reason);

        assert.ok(result.reason.includes('package.json'));

    });



    it('routes back to preflight when configured ordinary docs match dependency text drift', () => {

        const repoRoot = makeTempRepo();

        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json'), {

            ordinary_doc_paths: ['requirements.txt']

        });

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.writeFileSync(path.join(repoRoot, 'requirements.txt'), 'pytest==8.0.0\n', 'utf8');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'restart-coherent-cycle');

        assert.ok(result.reason.includes('stale preflight'), result.reason);

        assert.ok(result.reason.includes('requirements.txt'));

    });



    it('routes back to preflight when post-review drift includes an undeclared source file', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });

        seedCompilePass(repoRoot, TASK_ID);

        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });

        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI reference\n\nUpdated doc-impact flow.\n', 'utf8');

        fs.writeFileSync(path.join(repoRoot, 'src', 'extra.ts'), 'export const undeclared = true;\n', 'utf8');

        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`), {

            task_id: TASK_ID,

            decision: 'DOCS_UPDATED',

            status: 'PASSED',

            outcome: 'PASS',

            preflight_path: preflightPath,

            docs_updated: ['docs/cli-reference.md'],

            behavior_changed: false,

            changelog_updated: false

        });

        appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'restart-coherent-cycle');

        assert.ok(result.reason.includes('stale preflight'), result.reason);

        assert.ok(result.reason.includes('src/extra.ts'));

    });



});
