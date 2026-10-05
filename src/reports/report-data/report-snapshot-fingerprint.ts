import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleNameForTarget } from '../../core/constants';
import { getBackupSnapshotsRoot } from '../../lifecycle/backups';
import { statFingerprint } from './shared';

const MAX_RUNTIME_FINGERPRINT_SCAN_ENTRIES = 512;

interface SnapshotFingerprint {
    value: string;
    complete: boolean;
}

function treeFingerprint(rootPath: string, fileNamePattern: RegExp | null = null): SnapshotFingerprint {
    if (!fs.existsSync(rootPath)) {
        return { value: `${rootPath}:missing`, complete: true };
    }
    const entries: string[] = [];
    const stack = [rootPath];
    let visited = 0;
    let truncated = false;
    while (stack.length > 0 && visited < MAX_RUNTIME_FINGERPRINT_SCAN_ENTRIES) {
        const current = stack.pop() as string;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            visited += 1;
            if (visited > MAX_RUNTIME_FINGERPRINT_SCAN_ENTRIES) {
                truncated = true;
                break;
            }
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(entryPath);
                continue;
            }
            if (fileNamePattern && !fileNamePattern.test(entry.name)) {
                continue;
            }
            entries.push(statFingerprint(entryPath));
        }
    }
    if (stack.length > 0) {
        truncated = true;
    }
    const body = entries.sort().join(';') || `${rootPath}:empty`;
    return {
        value: truncated
            ? `${body};${rootPath}:scan_truncated:${MAX_RUNTIME_FINGERPRINT_SCAN_ENTRIES}`
            : body,
        complete: !truncated
    };
}

function buildReportSnapshot(repoRoot: string): SnapshotFingerprint {
    const resolvedRoot = path.resolve(repoRoot);
    const bundleRoot = path.join(resolvedRoot, resolveBundleNameForTarget(resolvedRoot));
    const runtimeRoot = path.join(bundleRoot, 'runtime');
    const runtimeTrees = [
        treeFingerprint(path.join(runtimeRoot, 'task-events'), /\.lock(?:\.json)?$/iu),
        treeFingerprint(path.join(runtimeRoot, 'task-events'), /\.jsonl$/iu),
        treeFingerprint(path.join(runtimeRoot, 'reviews'), /(?:-quality-checklist|-preflight)\.json$/iu),
        treeFingerprint(path.join(runtimeRoot, 'full-suite'), /\.lock(?:\.json)?$/iu),
        treeFingerprint(path.join(runtimeRoot, 'locks'), /\.lock(?:\.json)?$/iu)
    ];
    const value = [
        statFingerprint(path.join(resolvedRoot, TASK_QUEUE_FILENAME)),
        statFingerprint(path.join(resolvedRoot, 'AGENTS.md')),
        statFingerprint(path.join(bundleRoot, 'live', 'config', 'workflow-config.json')),
        statFingerprint(path.join(bundleRoot, 'live', 'config', 'profiles.json')),
        statFingerprint(path.join(bundleRoot, 'template', 'config', 'profiles.json')),
        statFingerprint(path.join(bundleRoot, 'runtime', 'workflow-config-audit.jsonl')),
        statFingerprint(path.join(bundleRoot, 'runtime', 'profile-finding-policy-audit.jsonl')),
        statFingerprint(path.join(bundleRoot, 'live', 'config', 'task-reset-enablement-receipt.json')),
        statFingerprint(path.join(bundleRoot, 'runtime', 'protected-control-plane-manifest.json')),
        statFingerprint(path.join(bundleRoot, 'live', 'config', 'paths.json')),
        statFingerprint(path.join(bundleRoot, 'runtime', 'init-answers.json')),
        statFingerprint(path.join(bundleRoot, 'runtime', 'agent-init-state.json')),
        statFingerprint(path.join(runtimeRoot, 'metrics', 'full-suite-validation-duration-history.json')),
        statFingerprint(path.join(runtimeRoot, 'switch', 'state.json')),
        statFingerprint(path.join(runtimeRoot, 'switch', 'off', 'AGENTS.md')),
        ...runtimeTrees.map((tree) => tree.value),
        statFingerprint(getBackupSnapshotsRoot(resolvedRoot))
    ].join('|');
    return { value, complete: runtimeTrees.every((tree) => tree.complete) };
}

export function buildReportSnapshotFingerprint(repoRoot: string): string {
    return buildReportSnapshot(repoRoot).value;
}

export function buildReportSnapshotCacheKey(repoRoot: string): string | null {
    const snapshot = buildReportSnapshot(repoRoot);
    // An incomplete scan cannot rule out changes in files outside the scan budget.
    return snapshot.complete ? snapshot.value : null;
}
