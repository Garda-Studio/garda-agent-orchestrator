import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, mock } from 'node:test';

import * as compileGate from '../../../../../../src/gates/compile/compile-gate';
import { fileSha256 } from '../../../../../../src/gates/shared/helpers';
import { resolveCurrentRemediationChangedFiles } from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-remediation-artifacts';

describe('remediation task-entry dirty baseline', () => {
    function fixture() {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-remediation-baseline-'));
        const baselineFile = path.join(repoRoot, 'package.json');
        fs.writeFileSync(baselineFile, '{"version":"1.4.3"}\n');
        const baseline = {
            changed_files: ['package.json'],
            file_hashes: { 'package.json': fileSha256(baselineFile) }
        };
        const snapshotMock = mock.method(compileGate, 'getWorkspaceSnapshot', () => ({
            changed_files: ['package.json', 'src/task.ts', 'tests/task.test.ts', 'src/new.ts']
        }));
        return {
            repoRoot, baselineFile, baseline,
            close() {
                snapshotMock.mock.restore();
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        };
    }

    it('excludes untouched entry changes but retains task changes and newly discovered files', () => {
        const f = fixture();
        try {
            assert.deepEqual(resolveCurrentRemediationChangedFiles(f.repoRoot, {
                changedFiles: ['src/task.ts', 'tests/task.test.ts'],
                plannedChangedFiles: ['src/task.ts', 'tests/task.test.ts'],
                detectionSource: 'explicit_changed_files'
            }, f.baseline), ['src/new.ts', 'src/task.ts', 'tests/task.test.ts']);
        } finally { f.close(); }
    });

    it('retains an unchanged baseline file when it belongs to the explicit review scope', () => {
        const f = fixture();
        try {
            assert.deepEqual(resolveCurrentRemediationChangedFiles(f.repoRoot, {
                changedFiles: ['package.json', 'src/task.ts'],
                plannedChangedFiles: ['package.json', 'src/task.ts'],
                detectionSource: 'explicit_changed_files'
            }, f.baseline), ['package.json', 'src/new.ts', 'src/task.ts', 'tests/task.test.ts']);
        } finally { f.close(); }
    });

    for (const change of ['modified', 'deleted', 'missing-hash'] as const) {
        it(`retains ${change} baseline evidence instead of hiding scope drift`, () => {
            const f = fixture();
            try {
                if (change === 'modified') fs.writeFileSync(f.baselineFile, '{"version":"changed"}\n');
                if (change === 'deleted') fs.unlinkSync(f.baselineFile);
                if (change === 'missing-hash') f.baseline.file_hashes['package.json'] = '';
                const files = resolveCurrentRemediationChangedFiles(f.repoRoot, {
                    plannedChangedFiles: ['src/task.ts'],
                    detectionSource: 'git_auto_current_workspace'
                }, f.baseline);
                assert.deepEqual(files, ['package.json', 'src/new.ts', 'src/task.ts', 'tests/task.test.ts']);
            } finally { f.close(); }
        });
    }

    it('preserves existing behavior when no task-entry baseline exists', () => {
        const f = fixture();
        try {
            assert.deepEqual(resolveCurrentRemediationChangedFiles(f.repoRoot, {
                plannedChangedFiles: [], detectionSource: 'git_auto_current_workspace'
            }), ['package.json', 'src/new.ts', 'src/task.ts', 'tests/task.test.ts']);
        } finally { f.close(); }
    });
});
