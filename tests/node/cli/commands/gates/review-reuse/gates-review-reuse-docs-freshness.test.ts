import test from 'node:test';
import { createHash } from 'node:crypto';
import {
    assert, fs, path, createTempRepo, getReviewsRoot, readTaskTimelineEvents,
    runEnterTaskMode, seedInitAnswers, seedReusableReviewEvidence, seedTaskQueue,
    writeCompilePassEvidence, writePreflight, runCliMainWithHandling
} from './gates-review-reuse-fixtures';

for (const includeTests of [false, true]) {
for (const frozenCustomTests of includeTests ? [false, true] : [false]) {
for (const schemaVersion of [3, 4] as const) {
    for (const changeDocument of [false, true]) {
        test(`schema ${schemaVersion} docs${includeTests ? ' and tests' : '-only'}${frozenCustomTests ? ' frozen custom policy' : ''} historical reuse ${changeDocument ? 'rejects changed bytes on repeated builds' : 'accepts unchanged bytes'}`, async (t) => {
            const repoRoot = createTempRepo(t);
            const taskId = `T-docs-reuse-${schemaVersion}-${changeDocument ? 'changed' : 'unchanged'}`;
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Qwen');
            if (frozenCustomTests) {
                const taskPath = path.join(repoRoot, 'TASK.md');
                fs.writeFileSync(taskPath, fs.readFileSync(taskPath, 'utf8').replace('| default | fixture |', '| balanced | fixture |'), 'utf8');
                fs.copyFileSync(path.resolve('template/config/profiles.json'), path.join(repoRoot, 'garda-agent-orchestrator/live/config/profiles.json'));
                fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator/live/config/paths.json'), JSON.stringify({
                    runtime_roots: ['src/', 'tests/', 'custom-specs/'], triggers: { test: ['(^|/)custom-specs/'] }
                }), 'utf8');
            }
            runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Review documentation content once before historical reuse' });
            const taskMode = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8'));
            const preflightPolicy = frozenCustomTests ? { profile_policy_snapshot: taskMode.profile_policy_snapshot } : {};
            if (frozenCustomTests) {
                assert.deepEqual(taskMode.profile_policy_snapshot.review_trigger_policy.test_path_regexes, ['(^|/)custom-specs/']);
            }
            const changedFiles = ['docs/usage.md'];
            if (includeTests) {
                fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator/live/config/paths.json'), JSON.stringify({
                    runtime_roots: ['src/', 'tests/', 'custom-specs/']
                }), 'utf8');
                const testPath = frozenCustomTests ? 'custom-specs/check.ts' : 'tests/node/docs/usage.test.ts';
                fs.mkdirSync(path.dirname(path.join(repoRoot, testPath)), { recursive: true });
                fs.writeFileSync(path.join(repoRoot, testPath), 'export const criteria = true;\n', 'utf8');
                changedFiles.push(testPath);
            }
            fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
            const docPath = path.join(repoRoot, 'docs/usage.md');
            const originalText = Array.from({ length: 30 }, (_, index) => `Original criterion ${index + 1}.`).join('\n') + '\n';
            fs.writeFileSync(docPath, originalText, 'utf8');
            const reviewsRoot = getReviewsRoot(repoRoot);
            const contextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
            const priorPreflight = writePreflight(repoRoot, taskId, {
                changed_files: changedFiles, scope_category: 'docs-only', ...preflightPolicy
            }, `${taskId}-prior-preflight.json`);
            seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflight, contextPath, 'agent:docs-reviewer', {
                reviewContextSchemaVersion: schemaVersion
            });
            if (changeDocument) {
                fs.writeFileSync(docPath, originalText.replace('Original criterion 1.', 'Different acceptance criterion.'), 'utf8');
            }
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: changedFiles, scope_category: 'docs-only', ...preflightPolicy
            });
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            const originalReceiptText = fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8');
            const initialRecordedCount = readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_RECORDED').length;
            const previousCwd = process.cwd();
            const previousExitCode = process.exitCode;
            try {
                process.chdir(repoRoot);
                process.exitCode = 0;
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    await runCliMainWithHandling([
                        'gate', 'build-review-context', '--review-type', 'code', '--depth', '2',
                        '--preflight-path', preflightPath, '--output-path', contextPath, '--repo-root', repoRoot
                    ]);
                    assert.equal(process.exitCode, 0);
                    const events = readTaskTimelineEvents(repoRoot, taskId).filter((event) => event.event_type === 'REVIEW_RECORDED');
                    if (changeDocument) {
                        assert.equal(events.length, initialRecordedCount, `Build ${attempt + 1} must not attest old documentation content.`);
                        assert.equal(fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8'), originalReceiptText);
                    } else {
                        assert.ok(events.length > initialRecordedCount);
                        assert.equal((events.at(-1)?.details as Record<string, unknown>).reused_existing_review, true);
                        const receipt = JSON.parse(fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8'));
                        assert.equal(receipt.review_context_sha256,
                            createHash('sha256').update(fs.readFileSync(contextPath)).digest('hex'),
                            `Build ${attempt + 1} must retain a receipt bound to the current context.`);
                    }
                }
            } finally {
                process.chdir(previousCwd);
                process.exitCode = previousExitCode;
            }
        });
    }
}
}
}
