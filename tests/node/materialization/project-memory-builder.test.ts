import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    seedProjectMemoryFromTemplate,
    validateSeededProjectMemory,
    writeProjectMemoryBootstrapReport
} from '../../../src/materialization/project-memory-builder';
import {
    PROJECT_MEMORY_REQUIRED_FILE_NAMES,
    resolveProjectMemoryBootstrapReportPath
} from '../../../src/core/project-memory';

function findRepoRoot() {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'template')) && fs.existsSync(path.join(current, 'package.json'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root.');
}

function copyDirRecursive(src: string, dst: string) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, dstPath);
        } else {
            fs.copyFileSync(srcPath, dstPath);
        }
    }
}

function setupBundleSkeleton() {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-pm-builder-'));
    const templateRoot = path.join(bundleRoot, 'template');
    const liveRoot = path.join(bundleRoot, 'live');
    copyDirRecursive(path.join(repoRoot, 'template', 'docs', 'project-memory'), path.join(templateRoot, 'docs', 'project-memory'));
    fs.mkdirSync(liveRoot, { recursive: true });
    return { bundleRoot, templateRoot, liveRoot };
}

describe('project-memory builder', () => {
    it('rejects a linked project-memory directory before seeding outside files', () => {
        const ws = setupBundleSkeleton();
        try {
            const outside = path.join(ws.bundleRoot, 'outside');
            fs.mkdirSync(outside);
            const docs = path.join(ws.liveRoot, 'docs');
            fs.mkdirSync(docs);
            try {
                fs.symlinkSync(outside, path.join(docs, 'project-memory'), 'junction');
            } catch (error: unknown) {
                if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) return;
                throw error;
            }
            assert.throws(() => seedProjectMemoryFromTemplate({
                templateRoot: ws.templateRoot,
                liveRoot: ws.liveRoot
            }), /symlink|junction/);
            assert.deepEqual(fs.readdirSync(outside), []);
        } finally {
            fs.rmSync(ws.bundleRoot, { recursive: true, force: true });
        }
    });

    it('seeds all required project-memory files into a fresh live directory', () => {
        const ws = setupBundleSkeleton();
        try {
            const result = seedProjectMemoryFromTemplate({
                templateRoot: ws.templateRoot,
                liveRoot: ws.liveRoot
            });

            assert.equal(result.seededDirectory, true);
            assert.deepEqual([...result.copiedFiles].sort(), [...PROJECT_MEMORY_REQUIRED_FILE_NAMES].sort());
            for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
                assert.ok(fs.existsSync(path.join(result.projectMemoryDir, fileName)), `${fileName} should be seeded`);
            }
        } finally {
            fs.rmSync(ws.bundleRoot, { recursive: true, force: true });
        }
    });

    it('adds missing seed files without overwriting existing user-owned memory files', () => {
        const ws = setupBundleSkeleton();
        try {
            const pmDir = path.join(ws.liveRoot, 'docs', 'project-memory');
            fs.mkdirSync(pmDir, { recursive: true });
            fs.writeFileSync(path.join(pmDir, 'compact.md'), '# Custom Compact\n\n## Durable\nKeep this.\n', 'utf8');

            const result = seedProjectMemoryFromTemplate({
                templateRoot: ws.templateRoot,
                liveRoot: ws.liveRoot
            });

            assert.equal(result.seededDirectory, false);
            assert.ok(result.preservedFiles.includes('compact.md'));
            assert.ok(
                result.templateUpdateNotices.some((notice) => notice.fileName === 'compact.md'),
                'preserved custom file should emit template guidance notice'
            );
            assert.equal(fs.readFileSync(path.join(pmDir, 'compact.md'), 'utf8'), '# Custom Compact\n\n## Durable\nKeep this.\n');
            assert.ok(fs.existsSync(path.join(pmDir, 'module-map.md')));
            assert.ok(fs.existsSync(path.join(pmDir, 'commands.md')));
            assert.ok(fs.existsSync(path.join(pmDir, 'risks.md')));
        } finally {
            fs.rmSync(ws.bundleRoot, { recursive: true, force: true });
        }
    });

    it('writes a schema-stable bootstrap report with validation and summary metadata', () => {
        const ws = setupBundleSkeleton();
        try {
            const seedResult = seedProjectMemoryFromTemplate({
                templateRoot: ws.templateRoot,
                liveRoot: ws.liveRoot
            });
            const validation = validateSeededProjectMemory(seedResult, { mode: 'check' });
            const summaryPath = path.join(ws.liveRoot, 'docs', 'agent-rules', '15-project-memory.md');
            fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
            fs.writeFileSync(summaryPath, '# Summary\n', 'utf8');

            const { path: reportPath, report } = writeProjectMemoryBootstrapReport({
                bundleRoot: ws.bundleRoot,
                timestampIso: '2026-05-05T00:00:00.000Z',
                seedResult,
                validation,
                summaryPath
            });

            assert.equal(reportPath, resolveProjectMemoryBootstrapReportPath(ws.bundleRoot));
            assert.ok(fs.existsSync(reportPath));
            assert.equal(report.schema_version, 1);
            assert.equal(report.project_memory.read_strategy, 'index_first');
            assert.ok(report.project_memory.read_first.includes('live/docs/project-memory/README.md'));
            assert.ok(report.project_memory.read_first.includes('live/docs/project-memory/compact.md'));
            assert.deepEqual(report.seed.template_update_notices, []);
            assert.equal(report.validation.mode, 'check');
            assert.equal(report.generated_summary.exists, true);
            assert.match(String(report.generated_summary.sha256), /^[a-f0-9]{64}$/);

            const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
            assert.equal(parsed.schema_version, 1);
            assert.equal(parsed.generated_summary.path, 'live/docs/agent-rules/15-project-memory.md');
        } finally {
            fs.rmSync(ws.bundleRoot, { recursive: true, force: true });
        }
    });
});
