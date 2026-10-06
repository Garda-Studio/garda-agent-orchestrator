import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizeOrdinaryDocPathPatterns } from '../../../../src/core/ordinary-doc-paths';
import { classifyChange } from '../../../../src/gates/preflight/classify-change';
import {
    getSafeOrdinaryDocPathMatches,
    isDocumentationLikePath,
    isProtectedControlPlaneDocumentationSurfacePath,
    isSafeOrdinaryDocumentationPath,
    isSecuritySensitiveDocumentationScopePath
} from '../../../../src/gates/preflight/classify-change-doc-safety';
import {
    runClassifyChangeCommand,
    runHandshakeDiagnosticsCommand,
    runShellSmokePreflightCommand
} from '../../../../src/cli/commands/gates';
import {
    createTempRepo,
    getOrchestratorRoot,
    initializeGitRepo,
    loadTaskEntryRulePack,
    runEnterTaskMode,
    seedInitAnswers,
    seedTaskQueue
} from '../../cli/commands/gates/preflight/gates-preflight-fixtures';
import { defaultCapabilities, makeConfig } from './classify-change-test-support';

const ordinaryDocPaths = ['docs/**', 'doc/**', 'examples/**', 'custom-notes/**'];
const config = makeConfig({ ordinary_doc_paths: ordinaryDocPaths });

function classifyFile(filePath: string) {
    return classifyChange({
        normalizedFiles: [filePath],
        taskIntent: 'Classify a changed file',
        changedLinesTotal: 5,
        additionsTotal: 5,
        deletionsTotal: 0,
        renameCount: 0,
        detectionSource: 'explicit_changed_files',
        classificationConfig: config,
        reviewCapabilities: defaultCapabilities
    });
}

describe('ordinary documentation file safety', () => {
    for (const stem of [
        'docs/worker', 'doc/worker', 'packages/help/docs/worker', 'README',
        'README/index', 'CHANGELOG', 'examples/worker', 'custom-notes/worker'
    ]) {
        it(`requires a documentation file form under ${stem}`, () => {
            for (const suffix of [
                'js', 'ts', 'mjs', 'cjs', 'py', 'java', 'cpp', 'c', 'sh',
                'ps1', 'vue', 'svelte', 'unknown', 'md.js', 'md.unknown'
            ]) {
                const filePath = `${stem}.${suffix}`;
                assert.equal(isDocumentationLikePath(filePath, ordinaryDocPaths), false, filePath);
                assert.equal(isSafeOrdinaryDocumentationPath(filePath, config), false, filePath);
                assert.deepEqual(getSafeOrdinaryDocPathMatches([filePath], config), [], filePath);
                assert.equal(classifyFile(filePath).scope_category, 'code', filePath);
            }
        });
    }

    it('rejects executable and unknown file forms under broad documentation paths', () => {
        assert.equal(isSafeOrdinaryDocumentationPath('docs/worker.js', config), false);
        assert.equal(isSafeOrdinaryDocumentationPath('custom-notes/worker.unknown', config), false);
        assert.equal(isSafeOrdinaryDocumentationPath('README/index.js', config), false);
    });

    it('keeps recognized tests out of documentation exemptions', () => {
        for (const filePath of [
            'docs/worker.test.ts', 'doc/worker.spec.js', 'README/index.test.py',
            'examples/tests/worker.mjs', 'custom-notes/tests/worker.ps1', 'docs/tests/worker.unknown'
        ]) {
            const result = classifyFile(filePath);
            assert.equal(result.scope_category, 'test-only', filePath);
            assert.equal(result.required_reviews.test, true, filePath);
            assert.deepEqual(result.triggers.ordinary_doc_path_matched_files, [], filePath);
            assert.deepEqual(result.triggers.test_ordinary_doc_suppressed_files, [], filePath);
        }
    });

    it('preserves text documentation and conventional extensionless files', () => {
        for (const filePath of [
            'README', 'CHANGELOG', 'LICENSE', 'NOTICE', 'CODEOWNERS', 'docs/guide.md',
            'doc/guide.mdx', 'packages/help/docs/guide.rst', 'examples/guide.adoc',
            'custom-notes/guide.asciidoc', 'docs/guide.txt', 'docs/guide.textile', 'DOCS/GUIDE.MD'
        ]) {
            assert.equal(isSafeOrdinaryDocumentationPath(filePath, config), true, filePath);
            assert.equal(classifyFile(filePath).scope_category, 'docs-only', filePath);
        }
        assert.equal(isSafeOrdinaryDocumentationPath('tests/plan.md', makeConfig({
            ordinary_doc_paths: ['tests/plan.md']
        })), true);
    });

    it('requires an exact explicit path for an unfamiliar extensionless document', () => {
        for (const filePath of ['docs/worker', 'doc/worker', 'examples/worker', 'custom-notes/worker']) {
            assert.equal(isSafeOrdinaryDocumentationPath(filePath, config), false, filePath);
        }
        assert.equal(isSafeOrdinaryDocumentationPath('BACKLOG', makeConfig({
            ordinary_doc_paths: ['BACKLOG']
        })), true);
        assert.equal(isSafeOrdinaryDocumentationPath('custom-notes/BACKLOG', makeConfig({
            ordinary_doc_paths: ['custom-notes/**', 'custom-notes/BACKLOG']
        })), true);
        assert.equal(isSafeOrdinaryDocumentationPath('custom-notes/worker', makeConfig({
            ordinary_doc_paths: ['custom-notes/']
        })), false);
    });

    it('rejects ordinary-doc overrides of sensitive and protected boundaries', () => {
        const protectedConfig = makeConfig({
            ordinary_doc_paths: ['docs/**', 'garda-agent-orchestrator/**'],
            protected_control_plane_roots: ['garda-agent-orchestrator/']
        });
        assert.equal(isSafeOrdinaryDocumentationPath('docs/security.md', protectedConfig), false);
        assert.equal(isSecuritySensitiveDocumentationScopePath('docs/security.md', protectedConfig), true);
        assert.equal(isSecuritySensitiveDocumentationScopePath('docs/security.sh', protectedConfig), false);
        assert.equal(isSafeOrdinaryDocumentationPath('garda-agent-orchestrator/live/docs/agent-rules/00-core.md', protectedConfig), false);
        assert.equal(isProtectedControlPlaneDocumentationSurfacePath('garda-agent-orchestrator/docs/guide.md', protectedConfig), true);
        assert.equal(isProtectedControlPlaneDocumentationSurfacePath('garda-agent-orchestrator/docs/worker.py', protectedConfig), false);
        assert.equal(isSafeOrdinaryDocumentationPath('docs/settings.json', protectedConfig), false);
    });

    it('keeps repository-wide wildcard and traversal configuration rejected', () => {
        assert.throws(() => normalizeOrdinaryDocPathPatterns(['**/*.md']));
        assert.throws(() => normalizeOrdinaryDocPathPatterns(['*/README.md']));
        assert.throws(() => normalizeOrdinaryDocPathPatterns(['../docs/**']));
        assert.throws(() => normalizeOrdinaryDocPathPatterns(['docs/../notes/**']));
    });
});

function prepareNativePreflight(profile: string) {
    const repoRoot = createTempRepo();
    const taskId = `T-170-doc-safety-${profile}`;
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    const configRoot = path.join(orchestratorRoot, 'live', 'config');
    fs.mkdirSync(configRoot, { recursive: true });
    const profiles = JSON.parse(fs.readFileSync(path.resolve('template/config/profiles.json'), 'utf8'));
    profiles.active_profile = profile;
    fs.writeFileSync(path.join(configRoot, 'profiles.json'), JSON.stringify(profiles));
    fs.writeFileSync(path.join(configRoot, 'paths.json'), JSON.stringify({ ordinary_doc_paths: ordinaryDocPaths }));
    fs.writeFileSync(path.join(configRoot, 'review-capabilities.json'), JSON.stringify(defaultCapabilities));
    seedTaskQueue(repoRoot, taskId, 'TODO', profile, 'fixture', 'Classify a single file');
    seedInitAnswers(repoRoot);
    fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n');
    fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# fixture router\n');
    fs.mkdirSync(path.join(orchestratorRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(orchestratorRoot, 'bin', 'garda.js'), "console.log('0.0.0-test');\n");
    initializeGitRepo(repoRoot);
    assert.equal(runEnterTaskMode({ repoRoot, taskId, provider: 'Codex', taskSummary: 'Classify a single file' }).exitCode, 0);
    assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
    const handshake = runHandshakeDiagnosticsCommand({ repoRoot, taskId, provider: 'Codex', emitMetrics: false });
    assert.equal(handshake.exitCode, 0, handshake.outputLines.join('\n'));
    const smoke = runShellSmokePreflightCommand({ repoRoot, taskId, emitMetrics: false });
    assert.equal(smoke.exitCode, 0, smoke.outputLines.join('\n'));
    return { repoRoot, taskId };
}

describe('native documentation safety decisions', () => {
    for (const profile of ['balanced', 'fast', 'strict']) {
        it(`uses safe documentation classification in the final ${profile} review snapshot`, () => {
            const { repoRoot, taskId } = prepareNativePreflight(profile);
            try {
                for (const [filePath, category] of [
                    ['docs/worker.js', 'code'], ['README.js', 'code'],
                    ['custom-notes/worker.unknown', 'code'], ['docs/worker.test.ts', 'test-only'],
                    ['docs/guide.md', 'docs-only'], ['examples/guide.rst', 'docs-only']
                ]) {
                    const absolutePath = path.join(repoRoot, filePath);
                    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
                    fs.writeFileSync(absolutePath, 'changed file\n');
                    const result = runClassifyChangeCommand({
                        repoRoot, taskId, changedFiles: [filePath], taskIntent: 'Classify a single file',
                        outputPath: path.join(repoRoot, 'garda-agent-orchestrator/runtime/reviews', `${taskId}-preflight.json`),
                        emitMetrics: false
                    });
                    const payload = JSON.parse(result.outputText);
                    assert.equal(payload.scope_category, category, filePath);
                    assert.equal(payload.profile_selection.effective_profile, profile);
                    assert.deepEqual(payload.effective_review_snapshot.required_reviews, payload.required_reviews);
                    if (category === 'docs-only') {
                        assert.equal(payload.required_reviews.code, false, filePath);
                        assert.equal(payload.required_reviews.test, false, filePath);
                    } else {
                        assert.deepEqual(payload.triggers.ordinary_doc_path_matched_files, [], filePath);
                        assert.deepEqual(payload.triggers.test_ordinary_doc_suppressed_files, [], filePath);
                        if (category === 'test-only') assert.equal(payload.required_reviews.test, true, filePath);
                        if (category === 'code' && profile !== 'fast') assert.equal(payload.required_reviews.code, true, filePath);
                    }
                    fs.unlinkSync(absolutePath);
                }
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });
    }
});
