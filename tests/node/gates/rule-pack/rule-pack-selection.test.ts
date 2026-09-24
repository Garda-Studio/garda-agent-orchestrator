import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import {
    getRulePackRequiredEntryFiles,
    getRulePackRequiredFilesFromPreflight,
    getRulePackStageKey,
    getLegacyPostPreflightRulePackFiles,
    getLegacyTaskEntryRulePackFiles,
    isCompatiblePostPreflightRuleFileSet,
    isCompatibleTaskEntryRuleFileSet,
    normalizeLoadedRuleFiles,
    selectTaskEntryRulePackFileNames
} from '../../../../src/gates/rule-pack/rule-pack-selection';
import { createTempRepo } from '../../cli/commands/gate-test-repo-bootstrap';

test('rule-pack selection distinguishes depth-one task entry from full entry and post-preflight stages', (t) => {
    const repoRoot = createTempRepo(t);
    const depthOneNames = selectTaskEntryRulePackFileNames({ effectiveDepth: 1 });
    const fullNames = selectTaskEntryRulePackFileNames({ effectiveDepth: 2 });
    assert.deepEqual(depthOneNames, ['00-core.md', '40-commands.md', '80-task-workflow.md']);
    assert.deepEqual(fullNames, [
        '00-core.md', '15-project-memory.md', '40-commands.md',
        '80-task-workflow.md', '90-skill-catalog.md'
    ]);
    assert.deepEqual(selectTaskEntryRulePackFileNames({ effectiveDepth: 0 }), fullNames);
    assert.equal(getRulePackStageKey('TASK_ENTRY'), 'task_entry');
    assert.equal(getRulePackStageKey('POST_PREFLIGHT'), 'post_preflight');

    const entry = getRulePackRequiredEntryFiles(repoRoot, 1);
    const post = getRulePackRequiredFilesFromPreflight(repoRoot, { test: true }, 1);
    assert.deepEqual(post, entry);
    assert.equal(isCompatibleTaskEntryRuleFileSet(repoRoot, entry, 1), true);
    assert.equal(isCompatiblePostPreflightRuleFileSet(repoRoot, post, { test: true }, 1), true);
    assert.equal(isCompatibleTaskEntryRuleFileSet(repoRoot, entry.slice(1), 1), false);
    assert.equal(isCompatiblePostPreflightRuleFileSet(repoRoot, post.slice(1), { test: true }, 1), false);
    const legacyEntry = getLegacyTaskEntryRulePackFiles(repoRoot);
    const legacyPost = getLegacyPostPreflightRulePackFiles(repoRoot, { test: true }, 1);
    assert.equal(isCompatibleTaskEntryRuleFileSet(repoRoot, legacyEntry, 1), true);
    assert.equal(isCompatiblePostPreflightRuleFileSet(repoRoot, legacyPost, { test: true }, 1), true);
    assert.equal(isCompatibleTaskEntryRuleFileSet(repoRoot, entry.map((file) => file.toUpperCase()), 1), true);
    assert.equal(isCompatiblePostPreflightRuleFileSet(repoRoot, post.map((file) => file.toUpperCase()), { test: true }, 1), true);
});

test('rule-pack selection normalizes duplicates and rejects missing or outside rule files', (t) => {
    const repoRoot = createTempRepo(t);
    const rulesRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules');
    const corePath = path.join(rulesRoot, '00-core.md').replace(/\\/gu, '/');
    assert.deepEqual(normalizeLoadedRuleFiles(repoRoot, [
        '00-core.md', corePath, '40-commands.md'
    ]), [corePath, path.join(rulesRoot, '40-commands.md').replace(/\\/gu, '/')].sort());
    assert.throws(() => normalizeLoadedRuleFiles(repoRoot, ['missing.md']), /Loaded rule file not found/u);
    assert.throws(() => normalizeLoadedRuleFiles(repoRoot, ['']), /contains an empty value/u);
    assert.throws(() => normalizeLoadedRuleFiles(repoRoot, [path.join(repoRoot, 'src', 'app.ts')]),
        /Loaded rule file must resolve inside/u);
});
