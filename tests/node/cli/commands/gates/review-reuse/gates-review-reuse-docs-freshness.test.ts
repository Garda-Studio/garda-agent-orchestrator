import test from 'node:test';
import {
    assert, fs, path, createTempRepo, getReviewsRoot, readTaskTimelineEvents,
    runEnterTaskMode, seedInitAnswers, seedReusableReviewEvidence, seedTaskQueue,
    writeCompilePassEvidence, writePreflight, runCliMainWithHandling
} from './gates-review-reuse-fixtures';

for (const schemaVersion of [3, 4] as const) {
    for (const changeDocument of [false, true]) {
        test(`schema ${schemaVersion} docs-only historical reuse ${changeDocument ? 'rejects changed bytes on repeated builds' : 'accepts unchanged bytes'}`, async (t) => {
            const repoRoot = createTempRepo(t);
            const taskId = `T-docs-reuse-${schemaVersion}-${changeDocument ? 'changed' : 'unchanged'}`;
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot, 'Qwen');
            runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Review documentation content once before historical reuse' });
            fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
            const docPath = path.join(repoRoot, 'docs/usage.md');
            const originalText = Array.from({ length: 30 }, (_, index) => `Original criterion ${index + 1}.`).join('\n') + '\n';
            fs.writeFileSync(docPath, originalText, 'utf8');
            const reviewsRoot = getReviewsRoot(repoRoot);
            const contextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
            const priorPreflight = writePreflight(repoRoot, taskId, {
                changed_files: ['docs/usage.md'], scope_category: 'docs-only'
            }, `${taskId}-prior-preflight.json`);
            seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflight, contextPath, 'agent:docs-reviewer', {
                reviewContextSchemaVersion: schemaVersion
            });
            if (changeDocument) {
                fs.writeFileSync(docPath, originalText.replace('Original criterion 1.', 'Different acceptance criterion.'), 'utf8');
            }
            const preflightPath = writePreflight(repoRoot, taskId, {
                changed_files: ['docs/usage.md'], scope_category: 'docs-only'
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
                    }
                }
            } finally {
                process.chdir(previousCwd);
                process.exitCode = previousExitCode;
            }
        });
    }
}
