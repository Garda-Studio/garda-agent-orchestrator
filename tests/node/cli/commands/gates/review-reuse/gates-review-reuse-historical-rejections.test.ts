import {
    describe,
    it,
    assert,
    fs,
    os,
    path,
    EXIT_GATE_FAILURE,
    runBuildReviewContextCommand,
    runRequiredReviewsCheckCommand,
    runCliMainWithHandling,
    buildReviewContext,
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash,
    computeReviewRelevantScopeFingerprint,
    appendTaskEvent,
    createTempRepo,
    findLastTimelineEventIndex,
    getOrchestratorRoot,
    getReviewsRoot,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    readTaskTimelineEvents,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeCompilePassEvidence,
    writePreflight,
    writeReceiptBackedReviewArtifact,
    stripLatestHistoricalReceiptSnapshotTelemetry,
    updateLatestHistoricalReviewRecordedDetails
} from './gates-review-reuse-fixtures';

describe('cli/commands/gates - historical review reuse rejections', () => {
    it('does not reuse historical review-recorded evidence when the historical artifact snapshot hash is tampered after receipt overwrite', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-historical-reuse-tampered-artifact-after-overwrite';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject historical review evidence when artifact snapshot hash is tampered after receipt overwrite'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const historicalReviewRecorded = readTaskTimelineEvents(repoRoot, taskId)
            .reverse()
            .find((event) => (
                event.event_type === 'REVIEW_RECORDED'
                && typeof event.details === 'object'
                && event.details !== null
                && !Array.isArray(event.details)
                && String((event.details as Record<string, unknown>).review_type || '').trim() === 'code'
            ));
        assert.ok(historicalReviewRecorded);
        const historicalDetails = historicalReviewRecorded.details as Record<string, unknown>;
        const artifactSnapshotPathRaw = String(historicalDetails.review_artifact_snapshot_path || '').trim();
        assert.ok(artifactSnapshotPathRaw);
        const artifactSnapshotPath = path.isAbsolute(artifactSnapshotPathRaw)
            ? artifactSnapshotPathRaw
            : path.resolve(repoRoot, artifactSnapshotPathRaw);
        fs.appendFileSync(artifactSnapshotPath, '\nTampered after the historical review was recorded.\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(receiptPath, JSON.stringify({
            ...originalReceipt,
            code_scope_sha256: computeCodeReviewScopeFingerprint(pollutedPreflight, repoRoot).code_scope_sha256,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        }, null, 2) + '\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.ok(result.outputLines.some((line) => line.includes('historical review artifact snapshot hash no longer matches telemetry')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse historical review-recorded evidence when the historical receipt snapshot hash is tampered after receipt overwrite', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-historical-reuse-tampered-receipt-after-overwrite';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject historical review evidence when receipt snapshot hash is tampered after receipt overwrite'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const historicalReviewRecorded = readTaskTimelineEvents(repoRoot, taskId)
            .reverse()
            .find((event) => (
                event.event_type === 'REVIEW_RECORDED'
                && typeof event.details === 'object'
                && event.details !== null
                && !Array.isArray(event.details)
                && String((event.details as Record<string, unknown>).review_type || '').trim() === 'code'
            ));
        assert.ok(historicalReviewRecorded);
        const historicalDetails = historicalReviewRecorded.details as Record<string, unknown>;
        const receiptSnapshotPathRaw = String(historicalDetails.receipt_snapshot_path || '').trim();
        assert.ok(receiptSnapshotPathRaw);
        const receiptSnapshotPath = path.isAbsolute(receiptSnapshotPathRaw)
            ? receiptSnapshotPathRaw
            : path.resolve(repoRoot, receiptSnapshotPathRaw);
        fs.appendFileSync(receiptSnapshotPath, '\nTampered historical receipt snapshot.\n', 'utf8');

        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(receiptPath, JSON.stringify({
            ...originalReceipt,
            code_scope_sha256: computeCodeReviewScopeFingerprint(pollutedPreflight, repoRoot).code_scope_sha256,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        }, null, 2) + '\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.ok(result.outputLines.some((line) => line.includes('historical review receipt snapshot hash no longer matches telemetry')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse historical review-recorded evidence when the receipt snapshot path is outside runtime reviews', async () => {
        const repoRoot = createTempRepo();
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-external-'));
        const taskId = 'T-904a-no-historical-reuse-external-receipt-snapshot';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject historical review evidence with an external receipt snapshot path'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const originalReceiptText = fs.readFileSync(receiptPath, 'utf8');
        const originalReceipt = JSON.parse(originalReceiptText) as Record<string, unknown>;
        const externalReceiptSnapshotPath = path.join(externalRoot, `${taskId}-code-receipt-external.json`);
        fs.writeFileSync(externalReceiptSnapshotPath, originalReceiptText, 'utf8');
        updateLatestHistoricalReviewRecordedDetails(repoRoot, taskId, 'code', (details) => {
            details.receipt_snapshot_path = path.normalize(externalReceiptSnapshotPath).replace(/\\/g, '/');
        });

        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(receiptPath, JSON.stringify({
            ...originalReceipt,
            code_scope_sha256: computeCodeReviewScopeFingerprint(pollutedPreflight, repoRoot).code_scope_sha256,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        }, null, 2) + '\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.ok(result.outputLines.some((line) => line.includes('historical review receipt snapshot path must reference canonical runtime review artifact')));

        fs.rmSync(externalRoot, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse historical review-recorded evidence when the review artifact path uses parent traversal', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-historical-reuse-traversal-review-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject historical review evidence with a traversal review artifact path'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const traversalArtifactDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'outside');
        fs.mkdirSync(traversalArtifactDir, { recursive: true });
        const historicalDetails = readTaskTimelineEvents(repoRoot, taskId)
            .reverse()
            .find((event) => {
                const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown>
                    : null;
                return (
                    event.event_type === 'REVIEW_RECORDED'
                    && details
                    && String(details.review_type || details.reviewType || '').trim().toLowerCase() === 'code'
                    && details.reused_existing_review !== true
                );
            })?.details as Record<string, unknown>;
        assert.ok(historicalDetails);
        const artifactSnapshotSha256 = String(historicalDetails.review_artifact_snapshot_sha256 || '').trim();
        assert.ok(artifactSnapshotSha256);
        const traversalArtifactPath = path.join(traversalArtifactDir, `${taskId}-code-artifact-${artifactSnapshotSha256}.md`);
        fs.copyFileSync(path.join(reviewsRoot, `${taskId}-code-artifact-${artifactSnapshotSha256}.md`), traversalArtifactPath);
        updateLatestHistoricalReviewRecordedDetails(repoRoot, taskId, 'code', (details) => {
            details.review_artifact_snapshot_path = `garda-agent-orchestrator/runtime/reviews/../outside/${taskId}-code-artifact-${artifactSnapshotSha256}.md`;
        });

        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(receiptPath, JSON.stringify({
            ...originalReceipt,
            code_scope_sha256: computeCodeReviewScopeFingerprint(pollutedPreflight, repoRoot).code_scope_sha256,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        }, null, 2) + '\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.ok(result.outputLines.some((line) => line.includes('historical review artifact snapshot path must not contain parent-directory traversal segments')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse the latest mutable receipt when historical telemetry lacks a verifiable source receipt hash', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-latest-receipt-reuse-without-source-receipt-hash';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject latest mutable receipt reuse when historical telemetry lacks source receipt hashes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');
        stripLatestHistoricalReceiptSnapshotTelemetry(repoRoot, taskId, 'code');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);
        assert.ok(result.outputLines.some((line) => line.includes('historical review receipt snapshot path is missing from REVIEW_RECORDED telemetry')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse code-review evidence for non-runtime performance support without performance review', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-code-no-reuse-performance-support';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse code review when benchmark support is not delegated'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const benchmark = "alpha";\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', 'benchmark/reviewed.ts'],
            metrics: { changed_lines_total: 4 },
            triggers: { performance: false },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, false);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: rejected'));
        assert.ok(codeBuild.outputLines.some((line) => (
            line.includes('non-runtime performance support file(s)')
            && line.includes('performance review is not required')
            && line.includes('benchmark/reviewed.ts')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse code-review evidence for non-src runtime performance paths', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-runtime-perf-code-no-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'apps', 'shop', 'perf'), { recursive: true });
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse code review for runtime performance paths'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'apps', 'shop', 'perf', 'cache.ts'), 'export const cache = "alpha";\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'code',
            changed_files: ['src/app.ts', 'apps/shop/perf/cache.ts'],
            metrics: { changed_lines_total: 4 },
            triggers: { performance: true },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: true,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, false);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: rejected'));
        assert.ok(codeBuild.outputLines.some((line) => line.includes('non-test scope changed')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse performance-review evidence when benchmark support content changes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-performance-support-no-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const benchmark = "alpha";\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse performance review after benchmark support changes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['benchmark/reviewed.ts'],
            metrics: { changed_lines_total: 3 },
            triggers: { performance: true },
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: true,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const performanceReviewContextPath = path.join(reviewsRoot, `${taskId}-performance-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'performance',
            'PERFORMANCE REVIEW PASSED',
            priorPreflightPath,
            performanceReviewContextPath,
            'agent:performance-reviewer'
        );

        fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const benchmark = "bravo";\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['benchmark/reviewed.ts'],
            metrics: { changed_lines_total: 3 },
            triggers: { performance: true },
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: true,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const performanceBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'performance',
            depth: 2,
            preflightPath,
            outputPath: performanceReviewContextPath
        });
        assert.equal(performanceBuild.reusedReviewEvidence, false);
        assert.ok(performanceBuild.outputLines.includes('ReviewReuseDecision: rejected'));
        assert.ok(performanceBuild.outputLines.some((line) => line.includes('non-test scope changed')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse historical review evidence when the current coverage contract differs', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-no-reuse-coverage-contract-change';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject historical review reuse when the current coverage contract differs'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            priorPreflightPath,
            reviewContextPath,
            'agent:code-reviewer'
        );
        const historicalContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const historicalCoverage = historicalContext.coverage_contract as Record<string, unknown>;

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 1 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const build = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        const currentContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const currentCoverage = currentContext.coverage_contract as Record<string, unknown>;

        assert.notEqual(historicalCoverage.contract_sha256, currentCoverage.contract_sha256);
        assert.notDeepEqual(historicalCoverage.obligations, currentCoverage.obligations);
        assert.equal(build.reusedReviewEvidence, false);
        assert.ok(build.outputLines.some((line) => line.includes(
            'reused review coverage contract does not match the current review context'
        )), build.outputLines.join('\n'));
        const repeatedBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(repeatedBuild.reusedReviewEvidence, false);
        assert.ok(repeatedBuild.outputLines.some((line) => line.includes(
            'reused review coverage contract does not match the current review context'
        )), repeatedBuild.outputLines.join('\n'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.equal(events.slice(latestCompileSequence + 1).some((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        )), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse review evidence after reviewer instruction content changes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-reuse-rule-context-change';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const codeReviewSkillPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'skills',
            'code-review',
            'SKILL.md'
        );
        fs.mkdirSync(path.dirname(codeReviewSkillPath), { recursive: true });
        fs.writeFileSync(codeReviewSkillPath, '# Code Review\n\nReview the assigned code scope.\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse review evidence after reviewer rule context changes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        fs.appendFileSync(
            codeReviewSkillPath,
            '\nReviewer instruction content changed after the prior review.\n',
            'utf8'
        );
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 1 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const build = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(build.reusedReviewEvidence, false);
        assert.ok(build.outputLines.some((line) => line.includes(
            'reused review rule context does not match the current review context'
        )), build.outputLines.join('\n'));
        const repeatedBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(repeatedBuild.reusedReviewEvidence, false);
        assert.ok(repeatedBuild.outputLines.some((line) => line.includes(
            'reused review rule context does not match the current review context'
        )), repeatedBuild.outputLines.join('\n'));

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentRecordedEvents = events.slice(latestCompileSequence + 1).filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(currentRecordedEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse context-mismatch evidence with missing or incorrect receipt contract bindings', async () => {
        const scenarios = [
            {
                suffix: 'coverage-mismatch',
                seedOptions: {
                    reviewCoverageContractSha256Override: 'f'.repeat(64)
                },
                expectedReason: 'reused review coverage contract does not match the current review context'
            },
            {
                suffix: 'missing-rule',
                seedOptions: {
                    omitReviewRuleContextBinding: true
                },
                expectedReason: 'reused review rule context does not match the current review context'
            }
        ];

        for (const scenario of scenarios) {
            const repoRoot = createTempRepo();
            const taskId = `T-904a-no-reuse-missing-binding-${scenario.suffix}`;
            try {
                seedTaskQueue(repoRoot, taskId);
                seedInitAnswers(repoRoot, 'Qwen');
                const reviewsRoot = getReviewsRoot(repoRoot);
                runEnterTaskMode({
                    repoRoot,
                    taskId,
                    taskSummary: 'Reject context-mismatch reuse without authenticated receipt contract bindings'
                });

                const priorPreflightPath = writePreflight(repoRoot, taskId, {
                    changed_files: ['src/app.ts'],
                    metrics: { changed_lines_total: 3 },
                    required_reviews: {
                        code: true,
                        db: false,
                        security: false,
                        refactor: false,
                        api: false,
                        test: false,
                        performance: false,
                        infra: false,
                        dependency: false
                    }
                }, `${taskId}-prior-preflight.json`);
                const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
                seedReusableReviewEvidence(
                    repoRoot,
                    taskId,
                    'code',
                    'REVIEW PASSED',
                    priorPreflightPath,
                    reviewContextPath,
                    'agent:code-reviewer',
                    scenario.seedOptions
                );
                const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
                const historicalReceiptText = fs.readFileSync(receiptPath, 'utf8');

                const preflightPath = writePreflight(repoRoot, taskId, {
                    changed_files: ['src/app.ts'],
                    metrics: { changed_lines_total: 3 },
                    required_reviews: {
                        code: true,
                        db: false,
                        security: false,
                        refactor: false,
                        api: false,
                        test: false,
                        performance: false,
                        infra: false,
                        dependency: false
                    }
                });
                writeCompilePassEvidence(repoRoot, taskId, preflightPath);

                const build = await runBuildReviewContextCommand({
                    repoRoot,
                    reviewType: 'code',
                    depth: 3,
                    preflightPath,
                    outputPath: reviewContextPath,
                    remediationPreservedScopeMismatchReason: 'test fixture preserves code scope across depth change'
                });
                assert.equal(build.reusedReviewEvidence, false);
                assert.ok(
                    build.outputLines.some((line) => line.includes(scenario.expectedReason)),
                    build.outputLines.join('\n')
                );
                assert.equal(fs.readFileSync(receiptPath, 'utf8'), historicalReceiptText);
                const events = readTaskTimelineEvents(repoRoot, taskId);
                const latestCompileSequence = findLastTimelineEventIndex(
                    events,
                    (event) => event.event_type === 'COMPILE_GATE_PASSED'
                );
                assert.equal(events.slice(latestCompileSequence + 1).some((event) => (
                    event.event_type === 'REVIEW_RECORDED'
                    && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
                )), false);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
    });

    it('does not reuse prior code-review evidence for a mixed docs plus code delta', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-docs-plus-code-no-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before a mixed docs and code delta'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Runtime code changed.\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', 'CHANGELOG.md'],
            metrics: { changed_lines_total: 6 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence without historical REVIEW_RECORDED binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-historical-record-binding';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse historical review evidence without recorded review binding'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
        const withoutHistoricalRecord = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => {
                if (!line.trim()) {
                    return false;
                }
                const event = JSON.parse(line) as Record<string, unknown>;
                return event.event_type !== 'REVIEW_RECORDED';
            })
            .join('\n') + '\n';
        fs.writeFileSync(timelinePath, withoutHistoricalRecord, 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence without historical reviewer tree-state binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-historical-tree-state-binding';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse historical review evidence without reviewer tree-state binding'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            priorPreflightPath,
            reviewContextPath,
            'agent:code-reviewer',
            { omitInvocationTreeState: true }
        );

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);
        assert.ok(result.outputLines.some((line) => line.includes('prior review provenance does not bind to the historical review-tree-state hash')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse historical review evidence when the delegated reviewer invocation window is too short', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-915-no-historical-reuse-too-short-window';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject historical review evidence whose delegated reviewer invocation window is too short'
        });

        const scopedPreflightInput = {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        };
        const priorPreflightPath = writePreflight(repoRoot, taskId, scopedPreflightInput, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            priorPreflightPath,
            reviewContextPath,
            'agent:code-reviewer',
            {
                invocationTimingOverride: {
                    launchPreparedAtUtc: '2026-04-28T00:00:00.000Z',
                    delegationStartedAtUtc: '2026-04-28T00:00:01.000Z',
                    launchedAtUtc: '2026-04-28T00:00:01.000Z',
                    // Delegated work window (delegation start -> launch completion) is only 4s,
                    // below the mandatory minimum delegated-work-window threshold.
                    launchCompletedAtUtc: '2026-04-28T00:00:05.000Z',
                    invocationAttestedAtUtc: '2026-04-28T00:00:05.500Z'
                }
            }
        );

        const preflightPath = writePreflight(repoRoot, taskId, scopedPreflightInput);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false, result.outputLines.join('\n'));
        const hiddenViolation = result.outputLines.find((line) => line.includes('not sufficiently trustworthy'));
        assert.ok(hiddenViolation, result.outputLines.join('\n'));
        assert.match(hiddenViolation as string, /Launch a real subagent using built-in tools/);
        assert.equal(
            /timing|threshold|elapsed|duration|seconds|too_short|impossible_ordering|missing_timing/i.test(hiddenViolation as string),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence when receipt scope hashes diverge from historical REVIEW_RECORDED telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-tampered-scope-binding';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse historical review evidence with tampered receipt scope hashes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const changed = true;\nconsole.log(changed);\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 4 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        buildReviewContext({
            reviewType: 'code',
            depth: 2,
            preflightPath,
            tokenEconomyConfigPath: path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json'),
            scopedDiffMetadataPath: path.join(reviewsRoot, `${taskId}-code-scoped.json`),
            outputPath: reviewContextPath,
            repoRoot
        });

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const currentReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const tamperedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        tamperedReceipt.code_scope_sha256 = computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256;
        tamperedReceipt.review_scope_sha256 = computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256;
        tamperedReceipt.review_context_reuse_sha256 = computeReviewContextReuseHash(currentReviewContext);
        fs.writeFileSync(receiptPath, JSON.stringify(tamperedReceipt, null, 2) + '\n', 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse failed review artifacts as current evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-failed-review-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse failed security review evidence'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: false,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'security',
            'SECURITY REVIEW FAILED',
            priorPreflightPath,
            reviewContextPath,
            'agent:security-reviewer'
        );
        const artifactPath = path.join(reviewsRoot, `${taskId}-security.md`);
        const artifactWithStrayPass = fs.readFileSync(artifactPath, 'utf8')
            .replace(
                '## Findings by Severity\nnone',
                '## Findings by Severity\nA prior failed review mentioned this literal token in explanatory text.\nSECURITY REVIEW PASSED'
            );
        fs.writeFileSync(artifactPath, artifactWithStrayPass, 'utf8');
        const artifactHash = require('node:crypto').createHash('sha256').update(artifactWithStrayPass).digest('hex');
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.review_artifact_sha256 = artifactHash;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
        const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
        const timeline = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .map((line) => {
                if (!line.trim()) {
                    return line;
                }
                const event = JSON.parse(line) as Record<string, unknown>;
                const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown>
                    : null;
                if (
                    event.event_type === 'REVIEW_RECORDED'
                    && details
                    && String(details.review_type || '').toLowerCase() === 'security'
                ) {
                    details.review_artifact_sha256 = artifactHash;
                }
                return JSON.stringify(event);
            })
            .join('\n');
        fs.writeFileSync(timelinePath, timeline.endsWith('\n') ? timeline : `${timeline}\n`, 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: false,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'security',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse findings JSON review evidence when the validation artifact is tampered', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-tampered-findings-validation-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse tampered findings validation evidence'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const validationReference = receipt.review_findings_validation as Record<string, unknown>;
        for (const validationPath of [
            String(validationReference.artifact_path || ''),
            String(validationReference.snapshot_path || '')
        ].filter(Boolean)) {
            fs.writeFileSync(path.normalize(validationPath), '{"tampered":true}\n', 'utf8');
        }

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not treat doc-named runtime code paths as docs-only reuse deltas', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-doc-named-runtime-code-no-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'docs', 'page.tsx'), 'export const Page = () => null;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before a doc-named runtime code delta'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'src', 'docs', 'page.tsx'), 'export const Page = () => <main>docs app</main>;\n', 'utf8');
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Runtime docs page changed.\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/docs/page.tsx', 'CHANGELOG.md'],
            metrics: { changed_lines_total: 5 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const fingerprint = computeCodeReviewScopeFingerprint(JSON.parse(fs.readFileSync(preflightPath, 'utf8')), repoRoot);
        assert.deepEqual(fingerprint.non_test_changed_files, ['src/docs/page.tsx']);
        assert.deepEqual(fingerprint.docs_only_changed_files, ['CHANGELOG.md']);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence when the runtime reviewer identity changes for the same code scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-reuse-runtime-identity';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Record a baseline code review before switching runtime provider'
        });
        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        writeCompilePassEvidence(repoRoot, taskId, priorPreflightPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');
        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'historical code review started', {
            review_type: 'code'
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'historical code review routing recorded', {
            review_type: 'code',
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_session_id: `self:${taskId}`,
            delegation_used: false,
            reviewer_fallback_reason: 'Codex provider_entrypoint fixtures cannot supply attested reviewer launch evidence.'
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'historical code review recorded', {
            review_type: 'code',
            reused_existing_review: false
        });

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Switch runtime provider while keeping the code scope unchanged',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.execution_provider, 'Antigravity');
        assert.equal(reviewContext.reviewer_routing.execution_provider_source, 'provider_bridge');
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestTaskModeIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'TASK_MODE_ENTERED');
        const postRestartReviewEvents = events.filter((event, index) => (
            index > latestTaskModeIndex
            && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEW_RECORDED')
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(postRestartReviewEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence when the code scope fingerprint changed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-reuse-code-review';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before the code scope changes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 1;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 6 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence when compile evidence does not belong to the current preflight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-stale-compile-evidence';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before stale compile validation'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 }
        }, `${taskId}-prior-preflight.json`);
        const staleCurrentPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 }
        }, `${taskId}-stale-current-preflight.json`);
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 6 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse code review evidence when compile evidence is stale'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, staleCurrentPreflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED');
        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            testReviewVerdict: 'TEST REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => line.includes('Compile gate evidence preflight hash mismatch')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
