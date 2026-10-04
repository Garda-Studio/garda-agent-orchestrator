import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as cleanup from '../../../src/lifecycle/cleanup';
import { appendMandatoryTaskEvent } from '../../../src/gate-runtime/task-events';
import {
    buildRestoreCommands, stableTimestampSlug,
    type SplitRequiredWipManifest
} from '../../../src/gates/split-required/split-required-wip-contracts';
import { retireSplitRequiredWip, restoreSplitRequiredWipForPreparedRuntimeHandoff } from '../../../src/gates/split-required/split-required-wip-operations';
import { captureAndSuspendSplitRequiredWip } from '../../../src/gates/split-required/split-required-wip';
import {
    prepareSplitRequiredWipRestoreHandoff, promotePreparedSplitRequiredWipRestoreHandoff,
    resolveSplitRequiredWipRestoreHandoffIdentity
} from '../../../src/gates/split-required/split-required-wip-runtime-handoff-contracts';

export interface WipSelection {
    targetRoot: string;
    taskIds: readonly string[];
    manifestPaths?: readonly string[];
}

export interface WipPreview {
    status: 'READY' | 'BLOCKED';
    task_ids: string[];
    ownership_digest: string;
    package_count: number;
    file_count: number;
    total_bytes: number;
    blockers: string[];
    packages: Array<{
        task_id: string;
        manifest_path: string;
        classification: 'retired-orphan' | 'referenced' | 'ambiguous';
        reference_task_ids: string[];
        blockers: string[];
    }>;
}

export interface WipRemoval {
    status: 'REMOVED' | 'BLOCKED' | 'INCOMPLETE' | 'CONFIRMATION_REQUIRED';
    removed_packages: string[];
    removed_file_count: number;
    removed_bytes: number;
    errors: string[];
}

const api = cleanup as typeof cleanup & Partial<{
    previewRetiredWipCleanup: (selection: WipSelection) => WipPreview;
    removeRetiredWipPackages: (options: WipSelection & {
        ownershipDigest: string; confirmed: boolean;
    }) => WipRemoval;
}>;

export function preview(selection: WipSelection): WipPreview {
    assert.equal(typeof api.previewRetiredWipCleanup, 'function', 'WIP preview backend must be exported');
    return api.previewRetiredWipCleanup!(selection);
}

export function remove(selection: WipSelection, ownershipDigest: string, confirmed = true): WipRemoval {
    assert.equal(typeof api.removeRetiredWipPackages, 'function', 'Confirmed WIP backend must be exported');
    return api.removeRetiredWipPackages!({ ...selection, ownershipDigest, confirmed });
}

export function sha256(content: string | Buffer): string {
    return createHash('sha256').update(content).digest('hex');
}

export function makeWipRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-cleanup-'));
    writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'DONE' }]);
    return root;
}

export function writeQueue(root: string, rows: Array<{ taskId: string; status: string; notes?: string }>): void {
    fs.writeFileSync(path.join(root, 'TASK.md'), [
        '# TASK.md', '', '## Active Queue', '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        ...rows.map(row => `| ${row.taskId} | ${row.status} | P1 | cleanup | WIP owner | codex | 2026-10-02 | strict | ${row.notes || ''} |`),
        ''
    ].join('\n'));
}

export function event(root: string, taskId: string, eventType: string, details: Record<string, unknown>, outcome = 'INFO') {
    return appendMandatoryTaskEvent(path.join(root, 'garda-agent-orchestrator'), taskId,
        eventType, outcome, eventType, details, { actor: 'orchestrator' });
}

export function createCapturedWip(root: string): { manifestPath: string; packageRoot: string } {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'WIP Cleanup Test');
    git('config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(root, '.gitignore'), 'garda-agent-orchestrator/runtime/\n');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const source = path.join(root, 'src/tracked.ts');
    fs.writeFileSync(source, 'export const tracked = 1;\n');
    writeQueue(root, [{ taskId: 'T-CLEAN-1', status: 'IN_PROGRESS' }]);
    git('add', '.');
    git('commit', '-m', 'WIP cleanup fixture baseline');
    fs.writeFileSync(source, 'export const tracked = 2;\n');
    fs.writeFileSync(path.join(root, 'src/generated.ts'), 'export const generated = 1;\n');
    const preflightPath = path.join(root, 'garda-agent-orchestrator/runtime/reviews/T-CLEAN-1-preflight.json');
    fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
    fs.writeFileSync(preflightPath, JSON.stringify({ task_id: 'T-CLEAN-1',
        changed_files: ['src/tracked.ts', 'src/generated.ts'], required_reviews: {},
        metrics: { changed_files_count: 2, changed_lines_total: 2 } }));
    const captured = captureAndSuspendSplitRequiredWip({ repoRoot: root, taskId: 'T-CLEAN-1',
        preflightPath, guardKind: 'scope_budget', guardReason: 'Production capture cleanup fixture.' });
    assert.equal(captured.status, 'CAPTURED', JSON.stringify(captured));
    assert.ok(captured.manifest_path);
    return { manifestPath: captured.manifest_path, packageRoot: path.dirname(captured.manifest_path) };
}

export function createPendingWipRestore(root: string) {
    const wip = createCapturedWip(root);
    const identity = resolveSplitRequiredWipRestoreHandoffIdentity({ repoRoot: root,
        taskId: 'T-CLEAN-1', manifestPath: wip.manifestPath });
    const prepared = prepareSplitRequiredWipRestoreHandoff(identity, identity.timelineAnchor);
    assert.equal(restoreSplitRequiredWipForPreparedRuntimeHandoff(identity).status, 'RESTORED');
    const handoff = promotePreparedSplitRequiredWipRestoreHandoff(identity);
    return { ...wip, identity, prepared, handoff };
}

export function createWip(root: string, options: {
    taskId?: string; ordinal?: number; retired?: boolean;
} = {}): { manifestPath: string; packageRoot: string; manifest: SplitRequiredWipManifest; artifactPath: string } {
    const taskId = options.taskId || 'T-CLEAN-1';
    const created = `2026-10-02T00:00:00.${String(options.ordinal || 1).padStart(3, '0')}Z`;
    const packageRoot = path.join(root, 'garda-agent-orchestrator/runtime/wip', taskId,
        'split-required', stableTimestampSlug(created));
    fs.mkdirSync(path.join(packageRoot, 'untracked/src'), { recursive: true });
    const manifestPath = path.join(packageRoot, 'manifest.json');
    const artifactPath = path.join(packageRoot, 'untracked/src/generated.ts');
    const payload = 'export const preservedSource = 1;\n';
    fs.writeFileSync(artifactPath, payload);
    const preflightPath = path.join(root, 'garda-agent-orchestrator/runtime/reviews', `${taskId}-preflight.json`);
    fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
    fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }));
    const patch = (name: string) => {
        const file = path.join(packageRoot, name);
        fs.writeFileSync(file, '');
        return { path: file, sha256: sha256(''), bytes: 0, empty: true };
    };
    const manifest: SplitRequiredWipManifest = {
        schema_version: 1, kind: 'split_required_wip', status: 'suspended', task_id: taskId,
        guard_kind: 'scope_budget', guard_reason: 'Fixture scope is suspended.', created_at_utc: created,
        base_commit: 'a'.repeat(40), preflight_path: preflightPath,
        preflight_sha256: sha256(fs.readFileSync(preflightPath)),
        patches: { staged: patch('staged.patch'), unstaged: patch('unstaged.patch') },
        tracked_files: [], untracked_files: [{ path: 'src/generated.ts', artifact_path: artifactPath,
            sha256: sha256(payload), bytes: Buffer.byteLength(payload) }],
        unrelated_untracked_files: [], ignored_runtime_artifacts: [],
        restore_commands: buildRestoreCommands(taskId, manifestPath)
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    event(root, taskId, 'SPLIT_REQUIRED_WIP_CAPTURED', {
        manifest_path: manifestPath, manifest_sha256: sha256(fs.readFileSync(manifestPath))
    });
    if (options.retired !== false) {
        assert.equal(retireSplitRequiredWip({ repoRoot: root, taskId, manifestPath,
            reason: 'Explicitly retired fixture source.' }).status, 'RETIRED');
    }
    return { manifestPath, packageRoot, artifactPath,
        manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SplitRequiredWipManifest };
}

export function treeSnapshot(root: string): string {
    const records: string[] = [];
    const visit = (directory: string): void => {
        for (const name of fs.readdirSync(directory).sort()) {
            const file = path.join(directory, name), stat = fs.lstatSync(file);
            const relative = path.relative(root, file).replace(/\\/gu, '/');
            if (stat.isSymbolicLink()) records.push(`link:${relative}:${fs.readlinkSync(file)}`);
            else if (stat.isDirectory()) { records.push(`dir:${relative}`); visit(file); }
            else records.push(`file:${relative}:${sha256(fs.readFileSync(file))}`);
        }
    };
    visit(root);
    return records.join('\n');
}
