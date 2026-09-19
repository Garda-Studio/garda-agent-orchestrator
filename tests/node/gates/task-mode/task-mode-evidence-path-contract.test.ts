import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getTaskModeEvidence } from '../../../../src/gates/task-mode';

test('getTaskModeEvidence reports a directory artifact path as missing evidence', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-mode-evidence-path-'));
    const artifactDirectory = path.join(repoRoot, 'task-mode-artifact');
    fs.mkdirSync(artifactDirectory);

    try {
        const evidence = getTaskModeEvidence(repoRoot, 'T-100', artifactDirectory);

        assert.equal(evidence.evidence_status, 'EVIDENCE_FILE_MISSING');
        assert.equal(evidence.evidence_path, artifactDirectory.replace(/\\/g, '/'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('getTaskModeEvidence rejects a hard-linked artifact as missing evidence', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-mode-evidence-path-'));
    const sourcePath = path.join(repoRoot, 'source.json');
    const artifactPath = path.join(repoRoot, 'task-mode.json');
    fs.writeFileSync(sourcePath, '{}\n', 'utf8');
    fs.linkSync(sourcePath, artifactPath);

    try {
        const evidence = getTaskModeEvidence(repoRoot, 'T-100', artifactPath);

        assert.equal(evidence.evidence_status, 'EVIDENCE_FILE_MISSING');
        assert.equal(evidence.evidence_path, artifactPath.replace(/\\/g, '/'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
