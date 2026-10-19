import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    MANAGED_START,
    MANAGED_END,
    COMMIT_GUARD_START,
    COMMIT_GUARD_END,
    extractManagedBlockFromContent,
    getTaskQueueTableRange,
    getTaskQueueRowsFromManagedBlock,
    setTaskQueueRowsInManagedBlock,
    buildTaskManagedBlockWithExistingQueue,
    buildTaskContentWithExistingQueue,
    hasLegacyDepthColumn,
    migrateDepthToProfileRow,
    buildCanonicalManagedBlock,
    buildRedirectManagedBlock,
    buildCommitGuardManagedBlock,
    buildProviderOrchestratorAgentContent,
    buildSharedStartTaskWorkflowContent,
    buildGitHubSkillBridgeAgentContent,
    buildQwenSettingsContent,
    buildClaudeLocalSettingsContent,
    buildVscodeSettingsContent,
    stripJsoncComments,
    IDE_EXCLUDED_DIRECTORIES,
    ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION,
    getLegacyUninstallBackupGitignoreEntry,
    UNINSTALL_BACKUP_GITIGNORE_COMMENT,
    getUninstallBackupGitignoreEntry,
    buildGitignoreEntries,
    buildManagedGitignoreBlock,
    syncManagedGitignoreBlockInContent,
    syncManagedBlockInContent
} from '../../../src/materialization/content-builders';
import {
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION,
    REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
    REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION
} from '../../../src/gate-runtime/reviewer-session-contract';

const TASK_ENTRY_RULE_FILE_SNIPPETS = Object.freeze([
    '--loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/00-core.md"',
    '--loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md"',
    '--loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/40-commands.md"',
    '--loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/80-task-workflow.md"',
    '--loaded-rule-file "garda-agent-orchestrator/live/docs/agent-rules/90-skill-catalog.md"'
]);

describe('extractManagedBlockFromContent', () => {
    it('extracts block between markers', () => {
        const content = `before\n${MANAGED_START}\ninner\n${MANAGED_END}\nafter`;
        const result = extractManagedBlockFromContent(content, MANAGED_START, MANAGED_END);
        assert.ok(result!.includes('inner'));
        assert.ok(result!.startsWith(MANAGED_START));
        assert.ok(result!.endsWith(MANAGED_END));
    });

    it('returns null for missing markers', () => {
        assert.equal(extractManagedBlockFromContent('no markers here', MANAGED_START, MANAGED_END), null);
    });

    it('returns null for empty content', () => {
        assert.equal(extractManagedBlockFromContent('', MANAGED_START, MANAGED_END), null);
        assert.equal(extractManagedBlockFromContent(null, MANAGED_START, MANAGED_END), null);
    });
});

describe('task queue operations', () => {
    const taskBlock = [
        MANAGED_START,
        '## Active Queue',
        '| ID | Status | Profile |',
        '|---|---|---|',
        '| T-001 | IN_PROGRESS | default |',
        '| T-002 | BACKLOG | fast |',
        '',
        '## Notes',
        MANAGED_END
    ].join('\n');

    it('getTaskQueueTableRange parses correctly', () => {
        const range = getTaskQueueTableRange(taskBlock);
        assert.ok(range);
        assert.equal(range.rowsStartIndex, 4);
        assert.equal(range.rowsEndIndex, 6);
    });

    it('getTaskQueueRowsFromManagedBlock extracts rows', () => {
        const rows = getTaskQueueRowsFromManagedBlock(taskBlock);
        assert.equal(rows.length, 2);
        assert.ok(rows[0].includes('T-001'));
        assert.ok(rows[1].includes('T-002'));
    });

    it('setTaskQueueRowsInManagedBlock replaces rows', () => {
        const newRows = ['| T-003 | DONE | 3 |'];
        const result = setTaskQueueRowsInManagedBlock(taskBlock, newRows);
        assert.ok(result!.includes('T-003'));
        assert.ok(!result.includes('T-001'));
    });

    it('returns empty rows for no table', () => {
        const noTable = `${MANAGED_START}\nNo queue here\n${MANAGED_END}`;
        assert.deepEqual(getTaskQueueRowsFromManagedBlock(noTable), []);
    });
});

describe('buildTaskManagedBlockWithExistingQueue', () => {
    it('preserves existing queue rows in template block', () => {
        const template = `${MANAGED_START}\n## Active Queue\n| ID | Status |\n|---|---|\n| T-NEW | BACKLOG |\n${MANAGED_END}`;
        const existing = `${MANAGED_START}\n## Active Queue\n| ID | Status |\n|---|---|\n| T-OLD | DONE |\n${MANAGED_END}`;
        const result = buildTaskManagedBlockWithExistingQueue(template, existing);
        assert.ok(result!.includes('T-OLD'));
    });

    it('returns template block when no existing', () => {
        const template = `${MANAGED_START}\nTemplate content\n${MANAGED_END}`;
        const result = buildTaskManagedBlockWithExistingQueue(template, '');
        assert.ok(result!.includes('Template content'));
    });

    it('migrates legacy Depth rows to Profile=default during rewrite', () => {
        const template = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-NEW | TODO | P1 | area | task | me | 2026-01-01 | default | new |',
            MANAGED_END
        ].join('\n');
        const existing = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Depth | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-001 | DONE | P1 | area | task | me | 2026-01-01 | 2 | notes |',
            MANAGED_END
        ].join('\n');
        const result = buildTaskManagedBlockWithExistingQueue(template, existing);
        assert.ok(result!.includes('Profile'));
        assert.ok(result!.includes('default'));
        assert.ok(!result!.includes('| 2 |'));
        assert.ok(result!.includes('T-001'));
    });

    it('preserves existing notes when migrating Depth to Profile', () => {
        const template = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            MANAGED_END
        ].join('\n');
        const existing = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Depth | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-002 | DONE | P1 | area | task | me | 2026-01-01 | 3 | existing notes |',
            MANAGED_END
        ].join('\n');
        const result = buildTaskManagedBlockWithExistingQueue(template, existing);
        assert.ok(result!.includes('default'));
        assert.ok(result!.includes('requested_depth=3'));
        assert.ok(result!.includes('existing notes'));
    });

    it('skips depth note injection when requested_depth already in notes', () => {
        const template = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            MANAGED_END
        ].join('\n');
        const existing = [
            MANAGED_START,
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Depth | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-003 | DONE | P1 | area | task | me | 2026-01-01 | 2 | requested_depth=2; effective_depth=2 |',
            MANAGED_END
        ].join('\n');
        const result = buildTaskManagedBlockWithExistingQueue(template, existing);
        assert.ok(result!.includes('default'));
        // Should not duplicate requested_depth
        const matches = result!.match(/requested_depth/g);
        assert.equal(matches!.length, 1);
    });
});

describe('buildTaskContentWithExistingQueue', () => {
    it('preserves queue rows and lower planning block when TASK.md is missing managed-end', () => {
        const template = [
            MANAGED_START,
            '# TASK.md',
            '',
            'Canonical instructions entrypoint for orchestration: `AGENTS.md`.',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-001 | 🟩 DONE | P1 | process | Template task | unassigned | 2026-01-01 | default | template |',
            MANAGED_END,
            ''
        ].join('\n');
        const existing = [
            MANAGED_START,
            '# TASK.md',
            '',
            'Old managed header.',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-237 | 🟦 TODO | P0 | reliability | Keep live queue | gpt-5.4 | 2026-04-24 | balanced | preserve me |',
            '',
            '',
            '## Блок очереди',
            '',
            '- `T-237` — сохранить нижний блок.'
        ].join('\n');

        const result = buildTaskContentWithExistingQueue(template, existing);

        assert.ok(result);
        assert.ok(result!.includes('Canonical instructions entrypoint for orchestration: `AGENTS.md`.'));
        assert.match(result!, /\| T-237 \| 🟦 TODO \| P0\s+\| reliability \| Keep live queue \| gpt-5\.4 \| 2026-04-24 \| balanced \| preserve me \|/);
        assert.ok(result!.includes('## Блок очереди'));
        assert.ok(result!.includes('- `T-237` — сохранить нижний блок.'));
        assert.ok(result!.includes(MANAGED_END));
        assert.ok(!result!.includes('Template task'));
        assert.ok(!result!.includes('Old managed header.'));
    });

    it('preserves content outside a valid TASK.md managed block', () => {
        const template = [
            MANAGED_START,
            '# TASK.md',
            '',
            'New header.',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-NEW | TODO | P1 | area | new | me | 2026-01-01 | default | new |',
            MANAGED_END,
            ''
        ].join('\n');
        const existing = [
            'preface',
            MANAGED_START,
            '# TASK.md',
            '',
            'Old header.',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-OLD | DONE | P1 | area | old | me | 2026-01-01 | default | old |',
            MANAGED_END,
            '',
            '## User Notes',
            'keep this'
        ].join('\n');

        const result = buildTaskContentWithExistingQueue(template, existing);

        assert.ok(result!.startsWith('preface\n'));
        assert.ok(result!.includes('New header.'));
        assert.match(result!, /\| T-OLD \| 🟩 DONE\s+\| P1\s+\| area \| old\s+\| me\s+\| 2026-01-01 \| default \| old\s+\|/);
        assert.ok(result!.includes('## User Notes'));
        assert.ok(result!.includes('keep this'));
        assert.ok(!result!.includes('T-NEW'));
    });

    it('keeps a fully user-owned TASK.md when no queue table can be parsed', () => {
        const template = [
            MANAGED_START,
            '# TASK.md',
            '',
            'New header.',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-NEW | TODO | P1 | area | new | me | 2026-01-01 | default | new |',
            MANAGED_END,
            ''
        ].join('\n');
        const existing = [
            '# User Tasks',
            '',
            '- Keep this original task list.',
            '- Keep operator notes too.'
        ].join('\n');

        const result = buildTaskContentWithExistingQueue(template, existing);

        assert.ok(result!.includes('New header.'));
        assert.ok(result!.includes('T-NEW'));
        assert.ok(result!.includes('# User Tasks'));
        assert.ok(result!.includes('- Keep this original task list.'));
        assert.ok(result!.includes('- Keep operator notes too.'));
    });

    it('preserves user prefix before an orphaned TASK.md managed block', () => {
        const template = [
            MANAGED_START,
            '# TASK.md',
            '',
            'New header.',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-NEW | TODO | P1 | area | new | me | 2026-01-01 | default | new |',
            MANAGED_END,
            ''
        ].join('\n');
        const existing = [
            'operator preface',
            '',
            MANAGED_START,
            '# TASK.md',
            '',
            'Old generated header.',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-OLD | TODO | P1 | area | old | me | 2026-01-01 | default | old |',
            '',
            '## User Notes',
            'keep suffix'
        ].join('\n');

        const result = buildTaskContentWithExistingQueue(template, existing);

        assert.ok(result!.startsWith('operator preface\n\n'));
        assert.ok(result!.includes('New header.'));
        assert.match(result!, /\| T-OLD \| 🟦 TODO\s+\| P1\s+\| area \| old\s+\| me\s+\| 2026-01-01 \| default \| old\s+\|/);
        assert.ok(result!.includes('## User Notes'));
        assert.ok(result!.includes('keep suffix'));
        assert.ok(!result!.includes('Old generated header.'));
        assert.ok(!result!.includes('T-NEW'));
    });

    it('separates the managed-end marker from preserved suffix when no blank line exists', () => {
        const template = [
            MANAGED_START,
            '# TASK.md',
            '',
            'New header.',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-NEW | TODO | P1 | area | new | me | 2026-01-01 | default | new |',
            MANAGED_END,
            ''
        ].join('\n');
        const existing = [
            MANAGED_START,
            '# TASK.md',
            '',
            'Old generated header.',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-OLD | TODO | P1 | area | old | me | 2026-01-01 | default | old |',
            '## User Notes',
            'keep suffix'
        ].join('\n');

        const result = buildTaskContentWithExistingQueue(template, existing);

        assert.ok(result!.includes(`${MANAGED_END}\n## User Notes`));
        assert.ok(!result!.includes(`${MANAGED_END}## User Notes`));
    });

    it('preserves lower notes for a missing managed-end TASK.md with an empty queue', () => {
        const template = [
            MANAGED_START,
            '# TASK.md',
            '',
            'New header.',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-NEW | TODO | P1 | area | new | me | 2026-01-01 | default | new |',
            MANAGED_END,
            ''
        ].join('\n');
        const existing = [
            MANAGED_START,
            '# TASK.md',
            '',
            'Old generated header.',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '## Operator Notes',
            'keep suffix'
        ].join('\n');

        const result = buildTaskContentWithExistingQueue(template, existing);

        assert.ok(result!.includes(`${MANAGED_END}\n## Operator Notes`));
        assert.ok(result!.includes('keep suffix'));
        assert.ok(!result!.includes('Old generated header.'));
    });

    it('reflows preserved Active Queue rows into one IDEA-compatible table', () => {
        const template = [
            MANAGED_START,
            '# TASK.md',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-NEW | TODO | P1 | area | new | me | 2026-01-01 | default | new |',
            MANAGED_END,
            ''
        ].join('\n');
        const existing = [
            MANAGED_START,
            '# TASK.md',
            '',
            '## Active Queue',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-703 | 🟦 TODO | P3 | task-queue/active-queue-formatting | Keep TASK.md table valid | gpt-5.4 | 2026-06-04 | balanced | preserve escaped \\| pipe |',
            '| T-704 | 🟪 DECOMPOSED | P2 | refactor | Parent | gpt-5.4 | 2026-06-04 | strict | preserve order |',
            MANAGED_END,
            '',
            '## Блок очереди',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|'
        ].join('\n');

        const result = buildTaskContentWithExistingQueue(template, existing);

        assert.match(result!, /\| T-703 \| 🟦 TODO\s+\| P3\s+\| task-queue\/active-queue-formatting \| Keep TASK\.md table valid \| gpt-5\.4 \| 2026-06-04 \| balanced \| preserve escaped \\\| pipe \|/);
        assert.match(result!, /\| T-704 \| 🟪 DECOMPOSED \| P2\s+\| refactor\s+\| Parent\s+\| gpt-5\.4 \| 2026-06-04 \| strict\s+\| preserve order\s+\|/);
        assert.ok(result!.includes('## Блок очереди\n| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |'));
    });
});

describe('hasLegacyDepthColumn', () => {
    it('returns true for old Depth header', () => {
        assert.ok(hasLegacyDepthColumn('| ID | Status | Depth | Notes |'));
    });

    it('returns false for new Profile header', () => {
        assert.ok(!hasLegacyDepthColumn('| ID | Status | Profile | Notes |'));
    });

    it('returns false when both Depth and Profile exist', () => {
        assert.ok(!hasLegacyDepthColumn('| ID | Depth | Profile |'));
    });
});

describe('migrateDepthToProfileRow', () => {
    it('converts numeric depth to default', () => {
        const row = '| T-001 | DONE | P1 | area | task | me | 2026-01-01 | 2 | notes |';
        const result = migrateDepthToProfileRow(row);
        assert.ok(result.includes('default'));
        assert.ok(!result.includes('| 2 |'));
    });

    it('preserves non-numeric profile-like values as-is', () => {
        const row = '| T-001 | DONE | P1 | area | task | me | 2026-01-01 | custom | notes |';
        const result = migrateDepthToProfileRow(row);
        assert.ok(result.includes('custom'), 'Non-numeric values should be preserved');
        assert.ok(!result.includes('requested_depth'));
    });

    it('adds requested_depth to notes for numeric values', () => {
        const row = '| T-001 | DONE | P1 | area | task | me | 2026-01-01 | 3 | some notes |';
        const result = migrateDepthToProfileRow(row);
        assert.ok(result.includes('requested_depth=3'));
        assert.ok(result.includes('some notes'));
    });

    it('returns short rows unchanged', () => {
        const row = '| T-001 | DONE |';
        assert.equal(migrateDepthToProfileRow(row), row);
    });
});

describe('buildCanonicalManagedBlock', () => {
    it('replaces neutral template title with canonical file', () => {
        const neutralTemplateContent = `${MANAGED_START}\n# canonical-rule-index.md\nSome content\n${MANAGED_END}`;
        const result = buildCanonicalManagedBlock('AGENTS.md', neutralTemplateContent);
        assert.ok(result!.includes('# AGENTS.md'));
        assert.ok(!result.includes('# canonical-rule-index.md'));
    });

    it('still rewrites legacy CLAUDE.md template titles for compatibility', () => {
        const templateClaudeContent = `${MANAGED_START}\n# CLAUDE.md\nSome content\n${MANAGED_END}`;
        const result = buildCanonicalManagedBlock('AGENTS.md', templateClaudeContent);
        assert.ok(result.includes('# AGENTS.md'));
        assert.ok(!result.includes('# CLAUDE.md'));
    });

    it('restores clickable rule links in deployed canonical entrypoints', () => {
        const templateClaudeContent = `${MANAGED_START}
# CLAUDE.md
## Rule Files
- \`garda-agent-orchestrator/live/docs/agent-rules/00-core.md\`
- \`garda-agent-orchestrator/live/docs/agent-rules/40-commands.md\`
${MANAGED_END}`;
        const result = buildCanonicalManagedBlock('CLAUDE.md', templateClaudeContent);
        assert.ok(result!.includes('- [Core Rules](./garda-agent-orchestrator/live/docs/agent-rules/00-core.md)'));
        assert.ok(result!.includes('- [Commands](./garda-agent-orchestrator/live/docs/agent-rules/40-commands.md)'));
        assert.ok(!result.includes('- `garda-agent-orchestrator/live/docs/agent-rules/00-core.md`'));
    });

    it('includes reviewer fresh-context and cleanup rules in canonical entrypoints', () => {
        const templateClaudeContent = `${MANAGED_START}
# CLAUDE.md
- Mandatory required reviewer launches must spawn a new clean-context delegated reviewer for the current review context; do not create, reserve, hold, or complete a reviewer before launch input exists, and do not reuse an existing reviewer session.
- After the review receipt is persisted by \`record-review-result\` or \`record-review-receipt\`, close or release the reviewer sub-agent session.
${MANAGED_END}`;
        const result = buildCanonicalManagedBlock('AGENTS.md', templateClaudeContent);
        assert.ok(result.includes('Mandatory required reviewer launches must spawn a new clean-context delegated reviewer'));
        assert.ok(result.includes('do not reuse an existing reviewer session'));
        assert.ok(result.includes('close or release the reviewer sub-agent session'));
    });

    it('adds Antigravity independent-review unavailable hard stop to canonical Antigravity entrypoint', () => {
        const templateContent = `${MANAGED_START}
# canonical-rule-index.md
- Mandatory required reviewer launches must spawn a new clean-context delegated reviewer for the current review context; do not create, reserve, hold, or complete a reviewer before launch input exists, and do not reuse an existing reviewer session.
${MANAGED_END}`;
        const result = buildCanonicalManagedBlock('.antigravity/rules.md', templateContent);
        assert.ok(result.includes(ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION));
        assert.ok(result.includes('do not write review output files'));
        assert.ok(result.includes('do not invent reviewer launch routing, telemetry, receipts, or review artifacts'));
    });

    it('does not add Antigravity-specific hard stop to other canonical entrypoints', () => {
        const templateContent = `${MANAGED_START}
# canonical-rule-index.md
- Mandatory required reviewer launches must spawn a new clean-context delegated reviewer for the current review context; do not create, reserve, hold, or complete a reviewer before launch input exists, and do not reuse an existing reviewer session.
${MANAGED_END}`;
        const result = buildCanonicalManagedBlock('AGENTS.md', templateContent);
        assert.ok(!result.includes(ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION));
    });

    it('throws for missing managed block', () => {
        assert.throws(
            () => buildCanonicalManagedBlock('AGENTS.md', 'no managed block'),
            /managed block is missing/
        );
    });
});

describe('buildRedirectManagedBlock', () => {
    it('generates redirect with provider bridge lines', () => {
        const result = buildRedirectManagedBlock(
            'AGENTS.md', 'CLAUDE.md',
            ['.github/agents/orchestrator.md']
        );
        assert.ok(result!.includes(MANAGED_START));
        assert.ok(result!.includes(MANAGED_END));
        assert.ok(result!.includes('# AGENTS.md'));
        assert.ok(result!.includes('redirect'));
        assert.ok(result!.includes('CLAUDE.md'));
        assert.ok(result!.includes('GitHub Copilot Agents'));
        assert.ok(result!.includes('.agents/workflows/start-task.md'));
    });

    it('shows no-bridge message when no providers', () => {
        const result = buildRedirectManagedBlock('GEMINI.md', 'CLAUDE.md', []);
        assert.ok(result!.includes('No provider-specific bridge files'));
    });

    it('includes compact-command protocol reference', () => {
        const result = buildRedirectManagedBlock(
            'AGENTS.md', 'CLAUDE.md',
            ['.github/agents/orchestrator.md']
        );
        assert.ok(result!.includes('compact command protocol'));
        assert.ok(result!.includes('scan'));
        assert.ok(result!.includes('inspect'));
        assert.ok(result!.includes('debug'));
    });

    it('adds Antigravity independent-review unavailable hard stop to Antigravity redirects only', () => {
        const antigravity = buildRedirectManagedBlock(
            '.antigravity/rules.md', 'AGENTS.md',
            ['.antigravity/agents/orchestrator.md']
        );
        const windsurf = buildRedirectManagedBlock(
            '.windsurf/rules/rules.md', 'AGENTS.md',
            ['.windsurf/agents/orchestrator.md']
        );
        assert.ok(antigravity.includes(ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION));
        assert.ok(!windsurf.includes(ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION));
    });
});

describe('buildCommitGuardManagedBlock', () => {
    it('produces valid bash hook script', () => {
        const result = buildCommitGuardManagedBlock();
        assert.ok(result!.includes(COMMIT_GUARD_START));
        assert.ok(result!.includes(COMMIT_GUARD_END));
        assert.ok(result!.includes('GARDA_ALLOW_COMMIT'));
        assert.ok(result!.includes('CODEX_THREAD_ID'));
        assert.ok(result!.includes('exit 1'));
    });
});

describe('buildProviderOrchestratorAgentContent', () => {
    it('includes required execution contract sections', () => {
        const result = buildProviderOrchestratorAgentContent('GitHub Copilot', 'CLAUDE.md', '.github/agents/orchestrator.md');
        assert.ok(result!.includes(MANAGED_START));
        assert.ok(result!.includes('GitHub Copilot Agent: Orchestrator'));
        assert.ok(result!.includes('Required Execution Contract'));
        assert.ok(result!.includes('Skill Routing'));
        assert.ok(result!.includes('Task Timeline Logging'));
        assert.ok(result!.includes('.github/agents/orchestrator.md'));
        assert.ok(result!.includes('.agents/workflows/start-task.md'));
        assert.ok(result!.includes('--provider "GitHub Copilot"'));
        assert.ok(result!.includes('--routed-to ".github/agents/orchestrator.md"'));
        assert.ok(result!.includes('Required runtime identity: use `--provider "GitHub Copilot"`'));
    });

    it('includes compact-command protocol in full provider bridge', () => {
        const result = buildProviderOrchestratorAgentContent('GitHub Copilot', 'CLAUDE.md', '.github/agents/orchestrator.md');
        assert.ok(result!.includes('compact command protocol'));
        assert.ok(result!.includes('40-commands.md'));
    });

    it('includes general dependent-reviewer launch discipline in full provider bridges', () => {
        const result = buildProviderOrchestratorAgentContent('GitHub Copilot', 'CLAUDE.md', '.github/agents/orchestrator.md');
        assert.ok(result!.includes('dependent downstream reviewer'));
        assert.ok(result!.includes('upstream accepted findings receipt reports findings-satisfied'));
        assert.ok(!result!.includes('before verdict capture'));
        assert.ok(!result!.includes('Review verdicts and completion status'));
        assert.ok(result!.includes('Parallel reviewer fan-out is allowed only between independent review types'));
        assert.ok(result!.includes('ReviewLaunchableBatch'));
        assert.ok(result!.includes('BlockedReviewLanes'));
        assert.ok(result!.includes('`NextReview` remains legacy single-lane compatibility'));
        assert.ok(result!.includes('full-suite validation blocks `test` review'));
        assert.ok(result!.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
        assert.ok(result!.includes('a generator, build or compile step followed by a command that consumes its output'));
    });

    it('pins delegated-only review receipt contract in full provider bridges', () => {
        const result = buildProviderOrchestratorAgentContent('GitHub Copilot', 'CLAUDE.md', '.github/agents/orchestrator.md');
        assert.ok(result!.includes('reviewer_execution_mode'));
        assert.ok(result!.includes('delegated_subagent'));
        assert.ok(result!.includes('reviewer_identity'));
        assert.ok(result!.includes('cannot satisfy a fresh mandatory review cycle'));
        assert.ok(!result!.includes('same_agent_fallback'));
    });

    it('pins fresh reviewer launch and cleanup contract in full provider bridges', () => {
        const result = buildProviderOrchestratorAgentContent('GitHub Copilot', 'CLAUDE.md', '.github/agents/orchestrator.md');
        assert.ok(result.includes(REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION));
        assert.ok(result.includes(REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION));
        assert.ok(result.includes(REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION));
        assert.ok(result.includes('Codex (delegation-capable): use the current Codex client\'s declared subagent tool and schema'));
        assert.ok(result.includes('reviewer-facing CopyPasteReviewerLaunchPrompt or ReviewerLaunchInputArtifactPath'));
        assert.ok(result.includes('not ReviewerLaunchArtifactPath control metadata'));
    });

    it('keeps legacy same_agent_fallback wording out of compact provider bridges too', () => {
        const result = buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md');
        assert.ok(result.includes('delegated_subagent'));
        assert.ok(result.includes('stale fallback metadata cannot satisfy a fresh cycle'));
        assert.ok(!result.includes('same_agent_fallback'));
    });

    it('pins fresh reviewer launch and cleanup contract in compact provider bridges', () => {
        const result = buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md');
        assert.ok(result.includes(REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION));
        assert.ok(result.includes(REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION));
        assert.ok(result.includes(REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION));
    });

    it('pins Antigravity hard stop for missing real delegated reviewer tooling', () => {
        const result = buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md');
        assert.ok(result.includes(ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION));
        assert.ok(result.includes('current runtime has no real provider sub-agent launch tool'));
        assert.ok(result.includes('do not invent reviewer launch routing, telemetry, receipts, or review artifacts'));
    });

    it('builds a compact Antigravity router instead of a full duplicate workflow', () => {
        const result = buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md');
        assert.ok(result.includes('Antigravity Agent: Orchestrator'));
        assert.ok(result.includes('.agents/workflows/start-task.md'));
        assert.ok(!result.includes('## Required Execution Contract'));
    });

    it('derives compact router behavior from bridge metadata instead of caller label', () => {
        const result = buildProviderOrchestratorAgentContent('Not Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md');
        assert.ok(result.includes('Antigravity Agent: Orchestrator'));
        assert.ok(!result.includes('## Required Execution Contract'));
    });

    it('fails fast when asked to build a provider bridge that is missing from the registry', () => {
        assert.throws(
            () => buildProviderOrchestratorAgentContent('Unknown Provider', 'AGENTS.md', '.unknown/agents/orchestrator.md'),
            /does not define bridge path/i
        );
    });

    it('includes compact-command protocol in Antigravity bridge', () => {
        const result = buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md');
        assert.ok(result!.includes('compact command protocol'));
        assert.ok(result!.includes('40-commands.md'));
    });

    it('includes general dependent-reviewer launch discipline in Antigravity bridge', () => {
        const result = buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md');
        assert.ok(result!.includes('dependent downstream reviewer'));
        assert.ok(result!.includes('upstream accepted findings receipt reports findings-satisfied'));
        assert.ok(result!.includes('Parallel reviewer fan-out is allowed only between independent review types'));
        assert.ok(result!.includes('ReviewLaunchableBatch'));
        assert.ok(result!.includes('BlockedReviewLanes'));
        assert.ok(result!.includes('`NextReview` remains legacy single-lane compatibility'));
        assert.ok(result!.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
        assert.ok(result!.includes('a generator, build or compile step followed by a command that consumes its output'));
    });

    it('includes exact copy-paste task-start snippets in full provider bridges', () => {
        const result = buildProviderOrchestratorAgentContent('GitHub Copilot', 'AGENTS.md', '.github/agents/orchestrator.md');
        assert.ok(result.includes('Copy-Paste Start Commands'));
        assert.ok(result.includes('First/resume command (source checkout): `node bin/garda.js next-step "<task-id>" --repo-root "."`'));
        assert.ok(result.includes('First/resume command (deployed workspace): `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."`'));
        assert.ok(result.includes('node bin/garda.js profile current|list|use|create --target-root "."'));
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js profile current|list|use|create --target-root "."'));
        assert.ok(result.includes('node bin/garda.js gate enter-task-mode --task-id "<task-id>"'));
        assert.ok(result.includes('--provider "GitHub Copilot"'));
        assert.ok(result.includes('--routed-to ".github/agents/orchestrator.md"'));
        assert.ok(result.includes('Required runtime identity: use `--provider "GitHub Copilot"`'));
        assert.ok(result.includes('node bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY"'));
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>"'));
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --provider "GitHub Copilot" --repo-root "."'));
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --provider "GitHub Copilot" --routed-to ".github/agents/orchestrator.md" --repo-root "."'));
        for (const ruleFileSnippet of TASK_ENTRY_RULE_FILE_SNIPPETS) {
            assert.ok(result.includes(ruleFileSnippet), ruleFileSnippet);
        }
    });

    it('includes exact copy-paste task-start snippets in compact provider bridges too', () => {
        const result = buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md');
        assert.ok(result.includes('Copy-Paste Start Commands'));
        assert.ok(result.includes('First/resume command (source checkout): `node bin/garda.js next-step "<task-id>" --repo-root "."`'));
        assert.ok(result.includes('First/resume command (deployed workspace): `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."`'));
        assert.ok(result.includes('node bin/garda.js profile current|list|use|create --target-root "."'));
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js profile current|list|use|create --target-root "."'));
        assert.ok(result.includes('--provider "Antigravity"'));
        assert.ok(result.includes('--routed-to ".antigravity/agents/orchestrator.md"'));
        assert.ok(result.includes('Required runtime identity: use `--provider "Antigravity"`'));
        assert.ok(result.includes('node bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY"'));
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --provider "Antigravity" --repo-root "."'));
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --provider "Antigravity" --routed-to ".antigravity/agents/orchestrator.md" --repo-root "."'));
        for (const ruleFileSnippet of TASK_ENTRY_RULE_FILE_SNIPPETS) {
            assert.ok(result.includes(ruleFileSnippet), ruleFileSnippet);
        }
    });

    it('uses the fixed deployed bundle name in provider bridge snippets', () => {
        const result = buildProviderOrchestratorAgentContent('GitHub Copilot', 'AGENTS.md', '.github/agents/orchestrator.md');
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>"'));
        assert.ok(result.includes('garda-agent-orchestrator/live/docs/agent-rules/00-core.md'));
    });
});

describe('buildSharedStartTaskWorkflowContent', () => {
    it('builds a compact checklist that routes every surface to canonical orchestration gates', () => {
        const result = buildSharedStartTaskWorkflowContent('AGENTS.md');
        assert.ok(result.includes('# Start Task'));
        assert.ok(result.includes('next-step "<task-id>"'));
        assert.ok(result.includes('Static gate order below is policy context'));
        assert.ok(result.includes('gate enter-task-mode'));
        assert.ok(result.includes('--routed-to "<provider-bridge-or-entrypoint>"'));
        assert.ok(result.includes('--provider "<provider>"'));
        assert.ok(result.includes('add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned'));
        assert.ok(result.includes('gate handshake-diagnostics'));
        assert.ok(result.includes('gate shell-smoke-preflight'));
        assert.ok(result.includes('gate completion-gate'));
        assert.ok(result.includes('shared start-task router'));
        assert.ok(result.includes('If an active provider bridge exists'));
        assert.ok(result.includes('Execute task <task-id> from TASK.md strictly through the orchestrator.'));
        assert.ok(result.includes('Use `next-step` as the navigator'));
        assert.ok(result.includes('launch a sub-agent using your internal tools'));
        assert.ok(result.includes('node bin/garda.js profile current|list|use|create --target-root "."'));
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js profile current|list|use|create --target-root "."'));
        assert.ok(result.includes('start marker'));
        assert.ok(result.includes('Garda captures my mind'));
        assert.ok(result.includes('this UX marker is not gate evidence'));
    });

    it('includes compact-command protocol reference', () => {
        const result = buildSharedStartTaskWorkflowContent('AGENTS.md');
        assert.ok(result.includes('compact command protocol'));
        assert.ok(result.includes('40-commands.md'));
    });

    it('includes dependent-reviewer launch blockers in hard stops', () => {
        const result = buildSharedStartTaskWorkflowContent('AGENTS.md');
        assert.ok(result.includes('Do not spawn or pre-launch a dependent downstream reviewer'));
        assert.ok(result.includes('Parallel reviewer fan-out is allowed only between independent review types'));
        assert.ok(result.includes('ReviewLaunchableBatch'));
        assert.ok(result.includes('BlockedReviewLanes'));
        assert.ok(result.includes('failed current reviews take remediation priority'));
        assert.ok(result.includes('full-suite validation blocks `test` review'));
        assert.ok(result.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'));
        assert.ok(result.includes('a generator, build or compile step followed by a command that consumes its output'));
    });

    it('includes fresh reviewer launch and cleanup blockers in hard stops', () => {
        const result = buildSharedStartTaskWorkflowContent('AGENTS.md');
        assert.ok(result.includes(REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION));
        assert.ok(result.includes(REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION));
        assert.ok(result.includes(REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION));
    });

    it('includes exact copy-paste task-start snippets for provider and routed task entry', () => {
        const result = buildSharedStartTaskWorkflowContent('AGENTS.md');
        assert.ok(result.includes('Copy-Paste Start Commands'));
        assert.ok(result.includes('node bin/garda.js gate enter-task-mode --task-id "<task-id>"'));
        assert.ok(result.includes('--provider "<runtime-provider>"'));
        assert.ok(result.includes('--routed-to "<provider-bridge-or-entrypoint>"'));
        assert.ok(result.includes('Required runtime identity: use `--provider "<runtime-provider>"`'));
        assert.ok(result.includes('node bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY"'));
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js gate load-rule-pack --task-id "<task-id>" --stage "TASK_ENTRY"'));
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --provider "<runtime-provider>" --repo-root "."'));
        assert.ok(result.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<task summary>" --provider "<runtime-provider>" --routed-to "<provider-bridge-or-entrypoint>" --repo-root "."'));
        for (const ruleFileSnippet of TASK_ENTRY_RULE_FILE_SNIPPETS) {
            assert.ok(result.includes(ruleFileSnippet), ruleFileSnippet);
        }
    });
});

describe('client-declared reviewer launch guidance', () => {
    it('rejects stale universal Codex launch assumptions across generated surfaces', () => {
        const surfaces = [
            buildSharedStartTaskWorkflowContent('AGENTS.md'),
            buildProviderOrchestratorAgentContent('GitHub Copilot', 'AGENTS.md', '.github/agents/orchestrator.md'),
            buildProviderOrchestratorAgentContent('Antigravity', 'AGENTS.md', '.antigravity/agents/orchestrator.md')
        ];
        assert.ok(surfaces.every(content => content.includes('current client\'s declared tool schema')));
        assert.ok(surfaces.every(content => content.includes('when collaboration.spawn_agent is exposed, use fork_turns="none"')));
        assert.ok(surfaces.every(content => content.includes('another isolation parameter only when that tool declares it')));
        assert.ok(surfaces.every(content => !content.includes('multi_agent_v1.spawn_agent')));
        assert.ok(surfaces.every(content => !/Codex should use[^.]*fork_context=false/.test(content)));
        assert.ok(surfaces.every(content => content.includes('exact generated CopyPasteReviewerLaunchPrompt or reviewer-facing ReviewerLaunchInputArtifactPath')));
        assert.ok(surfaces.every(content => content.includes('not ReviewerLaunchArtifactPath control metadata')));
        assert.ok(surfaces.every(content => content.includes('do not create, reserve, hold, or complete a reviewer before launch input exists')));
        assert.ok(surfaces.every(content => content.includes('do not reuse an existing reviewer session')));
        assert.ok(surfaces.every(content => content.includes('If the current provider session cannot launch a fresh delegated reviewer, stop')));
        assert.ok(surfaces.every(content => content.includes('After the review receipt is persisted, close or release the reviewer sub-agent session')));
    });
});

describe('buildGitHubSkillBridgeAgentContent', () => {
    it('includes skill bridge contract', () => {
        const result = buildGitHubSkillBridgeAgentContent(
            'Code Review Bridge', 'CLAUDE.md',
            'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            'required_reviews.code=true', 'always-on'
        );
        assert.ok(result!.includes(MANAGED_START));
        assert.ok(result!.includes('Code Review Bridge'));
        assert.ok(result!.includes('Skill Bridge Contract'));
        assert.ok(result!.includes('required_reviews.code=true'));
    });

    it('pins fresh reviewer launch and cleanup contract in GitHub skill bridges', () => {
        const result = buildGitHubSkillBridgeAgentContent(
            'Code Review Bridge', 'CLAUDE.md',
            'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            'required_reviews.code=true', 'always-on'
        );
        assert.ok(result.includes(REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION));
        assert.ok(result.includes(REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION));
    });

    it('includes compact-command protocol reference', () => {
        const result = buildGitHubSkillBridgeAgentContent(
            'Code Review Bridge', 'CLAUDE.md',
            'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            'required_reviews.code=true', 'always-on'
        );
        assert.ok(result!.includes('compact command protocol'));
        assert.ok(result!.includes('40-commands.md'));
    });
});

describe('buildQwenSettingsContent', () => {
    it('creates new settings with required entries', () => {
        const result = buildQwenSettingsContent(null, ['TASK.md', 'CLAUDE.md']);
        assert.equal(result!.needsUpdate, true);
        const parsed = JSON.parse(result.content);
        assert.ok(parsed.context.fileName.includes('TASK.md'));
        assert.ok(parsed.context.fileName.includes('CLAUDE.md'));
    });

    it('merges into existing settings', () => {
        const existing = JSON.stringify({ context: { fileName: ['TASK.md'] }, other: 'value' });
        const result = buildQwenSettingsContent(existing, ['TASK.md', 'CLAUDE.md']);
        assert.equal(result!.needsUpdate, true);
        assert.equal(result!.parseMode, 'merge-existing');
        const parsed = JSON.parse(result.content);
        assert.ok(parsed.context.fileName.includes('CLAUDE.md'));
        assert.equal(parsed.other, 'value');
    });

    it('reports no update needed when all entries present', () => {
        const existing = JSON.stringify({ context: { fileName: ['TASK.md', 'CLAUDE.md'] } });
        const result = buildQwenSettingsContent(existing, ['TASK.md', 'CLAUDE.md']);
        assert.equal(result!.needsUpdate, false);
    });

    it('handles invalid JSON gracefully', () => {
        const result = buildQwenSettingsContent('not json', ['TASK.md']);
        assert.equal(result!.parseMode, 'invalid-json');
        assert.equal(result!.needsUpdate, true);
    });
});

describe('buildClaudeLocalSettingsContent', () => {
    it('adds orchestrator allow entries when enabled', () => {
        const result = buildClaudeLocalSettingsContent(null, true);
        assert.equal(result!.needsUpdate, true);
        const parsed = JSON.parse(result.content);
        assert.ok(parsed.permissions.allow.length > 0);
        assert.ok(parsed.permissions.allow.some((e: string) => e.includes('bin/garda.js')));
    });

    it('does not add entries when disabled', () => {
        const result = buildClaudeLocalSettingsContent(null, false);
        const parsed = JSON.parse(result.content);
        assert.equal(parsed.permissions.allow.length, 0);
    });
});

describe('buildGitignoreEntries', () => {
    it('includes core entries', () => {
        const entries = buildGitignoreEntries(['CLAUDE.md'], [], false);
        assert.ok(entries.includes('garda-agent-orchestrator/'));
        assert.ok(entries.includes('TASK.md'));
        assert.ok(entries.includes('.qwen/'));
        assert.ok(!entries.includes('.review-temp/'));
    });

    it('includes .qwen/ in the managed baseline so later Qwen activation stays ignored', () => {
        const entries = buildGitignoreEntries(['CLAUDE.md'], [], false, true);
        assert.ok(entries.includes('.qwen/'));
    });

    it('adds AGENTS.md when active', () => {
        const entries = buildGitignoreEntries(['AGENTS.md'], [], false);
        assert.ok(entries.includes('AGENTS.md'));
    });

    it('adds QWEN.md when active', () => {
        const entries = buildGitignoreEntries(['QWEN.md'], [], false);
        assert.ok(entries.includes('QWEN.md'));
    });

    it('includes all supported entrypoint and provider ignore variants from the managed baseline', () => {
        const entries = buildGitignoreEntries(['CLAUDE.md'], [], false);
        assert.ok(entries.includes('CLAUDE.md'));
        assert.ok(entries.includes('AGENTS.md'));
        assert.ok(entries.includes('GEMINI.md'));
        assert.ok(entries.includes('QWEN.md'));
        assert.ok(entries.includes('.github/copilot-instructions.md'));
        assert.ok(entries.includes('.antigravity/'));
        assert.ok(entries.includes('.agents/workflows/start-task.md'));
        assert.ok(entries.includes('.junie/'));
        assert.ok(entries.includes('.windsurf/'));
        assert.ok(entries.includes('.qwen/'));
        assert.ok(!entries.includes('.review-temp/'));
        assert.ok(!entries.includes('.windsurf/rules/rules.md'));
        assert.ok(!entries.includes('.junie/guidelines.md'));
        assert.ok(!entries.includes('.antigravity/rules.md'));
    });

    it('adds .claude/ when claude access enabled', () => {
        const entries = buildGitignoreEntries(['CLAUDE.md'], [], true);
        assert.ok(entries.includes('.claude/'));
    });

    it('includes provider gitignore entries', () => {
        const profiles = [{ gitignoreEntries: ['.github/agents/', '.github/copilot-instructions.md'] }];
        const entries = buildGitignoreEntries(['.github/copilot-instructions.md'], profiles, false);
        assert.ok(entries.includes('.github/agents/'));
    });
});

describe('managed gitignore block sync', () => {
    it('builds a single canonical managed block', () => {
        const block = buildManagedGitignoreBlock(['TASK.md', 'AGENTS.md'], '\n');
        assert.equal(block, '# garda-agent-orchestrator managed ignores\nAGENTS.md\nTASK.md');
    });

    it('replaces an existing managed block in place', () => {
        const content = [
            'node_modules/',
            '# garda-agent-orchestrator managed ignores',
            'TASK.md',
            '.antigravity/rules.md',
            '',
            'coverage/'
        ].join('\n');
        const result = syncManagedGitignoreBlockInContent(content, ['TASK.md', '.antigravity/'], false);
        assert.ok(result.changed);
        assert.equal((result.content.match(/# garda-agent-orchestrator managed ignores/g) || []).length, 1);
        assert.ok(result.content.includes('.antigravity/'));
        assert.ok(!result.content.includes('.antigravity/rules.md'));
        assert.ok(result.content.includes('coverage/'));
    });

    it('collapses multiple managed blocks into one canonical block', () => {
        const content = [
            'node_modules/',
            '# garda-agent-orchestrator managed ignores',
            'AGENTS.md',
            '',
            '# garda-agent-orchestrator managed ignores',
            '.antigravity/rules.md',
            'coverage/'
        ].join('\n');
        const result = syncManagedGitignoreBlockInContent(content, ['TASK.md', '.antigravity/'], false);
        assert.equal((result.content.match(/# garda-agent-orchestrator managed ignores/g) || []).length, 1);
        assert.ok(result.content.includes('.antigravity/'));
        assert.ok(!result.content.includes('AGENTS.md\n\n# garda-agent-orchestrator managed ignores'));
        assert.ok(result.content.includes('coverage/'));
    });

    it('appends a managed block once when missing', () => {
        const result = syncManagedGitignoreBlockInContent('node_modules/\n', ['TASK.md', 'AGENTS.md'], false);
        assert.ok(result.changed);
        assert.equal((result.content.match(/# garda-agent-orchestrator managed ignores/g) || []).length, 1);
        assert.ok(result.content.includes('node_modules/'));
    });

    it('preserves a root-anchored control path without adding its bare variant', () => {
        const content = [
            'node_modules/',
            '/TASK.md',
            'garda-agent-orchestrator/',
            '.claude/',
            '# garda-agent-orchestrator managed ignores',
            'TASK.md',
            'AGENTS.md'
        ].join('\n');
        const result = syncManagedGitignoreBlockInContent(
            content,
            ['TASK.md', 'AGENTS.md', 'garda-agent-orchestrator/', '.claude/'],
            false
        );
        const lines = result.content.split(/\r?\n/);
        const managedStart = lines.indexOf('# garda-agent-orchestrator managed ignores');
        assert.ok(managedStart >= 0);
        const managedEntries: string[] = [];
        for (let i = managedStart + 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) {
                break;
            }
            managedEntries.push(line);
        }
        assert.deepEqual(managedEntries, ['AGENTS.md']);
        assert.ok(lines.includes('/TASK.md'));
        assert.ok(!lines.includes('TASK.md'));
        assert.ok(lines.includes('garda-agent-orchestrator/'));
        assert.ok(lines.includes('.claude/'));
    });

    it('preserves root-anchored file and directory entries, comments and CRLF bytes idempotently', () => {
        const entries = ['.agentignore', '.agents/workflows/start-task.md', '.qwen/',
            'AGENTS.md', 'TASK.md', 'garda-agent-orchestrator/'];
        const content = ['node_modules/', '# garda-agent-orchestrator managed ignores',
            '# Root controls only', ...entries.map(entry => '/' + entry), ''].join('\r\n');
        const result = syncManagedGitignoreBlockInContent(content, entries, false);
        assert.equal(result.content, content);
        assert.equal(result.changed, false);
        assert.equal(result.addedEntries, 0);
        assert.deepEqual(syncManagedGitignoreBlockInContent(result.content, entries, false), result);
    });

    it('rejects negated, commented, malformed or lookalike root control aliases', () => {
        const patterns = ['!/TASK.md', '# /TASK.md', '/TASK.md/', '/nested/TASK.md',
            '/TASK.md*', '/TASK?md', ' /TASK.md', '\\/TASK.md'];
        const results = patterns.map(pattern =>
            syncManagedGitignoreBlockInContent(pattern + '\n', ['TASK.md'], false));
        assert.deepEqual(results.map(result => result.addedEntries), patterns.map(() => 1));
        assert.deepEqual(results.map((result, index) => ({
            required: result.content.split('\n').includes('TASK.md'),
            original: result.content.split('\n').includes(patterns[index])
        })), patterns.map(() => ({ required: true, original: true })));
    });

    it('rejects a root-scoped substitute for a required global glob', () => {
        const result = syncManagedGitignoreBlockInContent('/*.log\n', ['*.log'], false);
        assert.equal(result.addedEntries, 1);
        assert.ok(result.content.split('\n').includes('*.log'));
        assert.ok(result.content.split('\n').includes('/*.log'));
    });

    it('migrates legacy uninstall backup ignore entries outside managed block', () => {
        const content = [
            'node_modules/',
            getUninstallBackupGitignoreEntry(),
            getLegacyUninstallBackupGitignoreEntry(),
            '# garda-agent-orchestrator managed ignores',
            'TASK.md'
        ].join('\n');
        const result = syncManagedGitignoreBlockInContent(content, ['TASK.md', 'AGENTS.md'], false);
        const lines = result.content.split(/\r?\n/);
        assert.ok(result.changed);
        assert.equal(lines.filter((line) => line === UNINSTALL_BACKUP_GITIGNORE_COMMENT).length, 1);
        assert.equal(lines.filter((line) => line === getUninstallBackupGitignoreEntry()).length, 1);
        assert.equal(lines.includes(getLegacyUninstallBackupGitignoreEntry()), false);
        assert.ok(lines.indexOf(getUninstallBackupGitignoreEntry()) < lines.indexOf('# garda-agent-orchestrator managed ignores'));
    });
});

describe('syncManagedBlockInContent', () => {
    it('replaces existing managed block', () => {
        const content = `before\r\n${MANAGED_START}\r\nold\r\n${MANAGED_END}\r\nafter`;
        const result = syncManagedBlockInContent(content, `${MANAGED_START}\r\nnew\r\n${MANAGED_END}`);
        assert.ok(result!.changed);
        assert.ok(result!.content.includes('new'));
        assert.ok(!result.content.includes('old'));
    });

    it('appends to empty content', () => {
        const result = syncManagedBlockInContent('', `${MANAGED_START}\ncontent\n${MANAGED_END}`);
        assert.ok(result!.changed);
        assert.ok(result!.content.includes(MANAGED_START));
    });

    it('replaces non-empty legacy content without block', () => {
        const result = syncManagedBlockInContent('existing content', `${MANAGED_START}\ncontent\n${MANAGED_END}`);
        assert.ok(result!.changed);
        assert.ok(result!.content.includes(MANAGED_START));
        assert.ok(!result.content.includes('existing content'));
    });
});

describe('buildVscodeSettingsContent', () => {
    it('creates settings with all IDE_EXCLUDED_DIRECTORIES when starting from empty', () => {
        const result = buildVscodeSettingsContent(null);
        assert.equal(result.needsUpdate, true);
        assert.equal(result.parseMode, 'default');

        const parsed = JSON.parse(result.content);
        for (const dir of IDE_EXCLUDED_DIRECTORIES) {
            const pattern = `**/${dir}`;
            assert.equal(parsed['files.exclude'][pattern], true, `files.exclude should have ${pattern}`);
            assert.equal(parsed['search.exclude'][pattern], true, `search.exclude should have ${pattern}`);
            assert.equal(parsed['files.watcherExclude'][pattern], true, `files.watcherExclude should have ${pattern}`);
        }
    });

    it('merges into existing settings without losing user entries', () => {
        const existing = JSON.stringify({
            'editor.fontSize': 14,
            'files.exclude': { '**/.git': true },
            'search.exclude': { '**/coverage': true }
        }, null, 2);
        const result = buildVscodeSettingsContent(existing);
        assert.equal(result.needsUpdate, true);
        assert.equal(result.parseMode, 'merge-existing');

        const parsed = JSON.parse(result.content);
        assert.equal(parsed['editor.fontSize'], 14, 'should preserve user settings');
        assert.equal(parsed['files.exclude']['**/.git'], true, 'should preserve existing excludes');
        assert.equal(parsed['search.exclude']['**/coverage'], true, 'should preserve existing excludes');
        assert.equal(parsed['files.exclude']['**/garda-agent-orchestrator'], true);
        assert.equal(parsed['search.exclude']['**/garda-agent-orchestrator'], true);
    });

    it('reports no update needed when all patterns already present', () => {
        const excludeMap: Record<string, boolean> = {};
        for (const dir of IDE_EXCLUDED_DIRECTORIES) {
            excludeMap[`**/${dir}`] = true;
        }
        const existing = JSON.stringify({
            'files.exclude': { ...excludeMap },
            'search.exclude': { ...excludeMap },
            'files.watcherExclude': { ...excludeMap }
        }, null, 2);
        const result = buildVscodeSettingsContent(existing);
        assert.equal(result.needsUpdate, false);
        assert.equal(result.parseMode, 'merge-existing');
    });

    it('handles invalid JSON gracefully', () => {
        const result = buildVscodeSettingsContent('not valid json');
        assert.equal(result.needsUpdate, true);
        assert.equal(result.parseMode, 'invalid-json');
        const parsed = JSON.parse(result.content);
        assert.equal(parsed['files.exclude']['**/dist'], true);
    });

    it('handles JSONC with comments without losing user settings', () => {
        const jsonc = [
            '{',
            '  // User comment about font size',
            '  "editor.fontSize": 14,',
            '  /* Block comment */',
            '  "files.exclude": { "**/.git": true }',
            '}'
        ].join('\n');
        const result = buildVscodeSettingsContent(jsonc);
        assert.equal(result.needsUpdate, true);
        assert.equal(result.parseMode, 'merge-existing');
        const parsed = JSON.parse(result.content);
        assert.equal(parsed['editor.fontSize'], 14, 'should preserve user settings from JSONC');
        assert.equal(parsed['files.exclude']['**/.git'], true, 'should preserve existing excludes');
        assert.equal(parsed['files.exclude']['**/dist'], true, 'should add orchestrator excludes');
    });

    it('handles JSONC with trailing commas', () => {
        const jsonc = '{\n  "editor.fontSize": 14,\n  "files.exclude": { "**/.git": true, },\n}';
        const result = buildVscodeSettingsContent(jsonc);
        assert.equal(result.parseMode, 'merge-existing');
        const parsed = JSON.parse(result.content);
        assert.equal(parsed['editor.fontSize'], 14);
        assert.equal(parsed['files.exclude']['**/.git'], true);
    });
});

describe('stripJsoncComments', () => {
    it('strips single-line comments', () => {
        const result = stripJsoncComments('{ // comment\n  "key": "val" }');
        assert.ok(JSON.parse(result));
        assert.equal(JSON.parse(result).key, 'val');
    });

    it('strips block comments', () => {
        const result = stripJsoncComments('{ /* comment */ "key": "val" }');
        assert.equal(JSON.parse(result).key, 'val');
    });

    it('preserves comment-like sequences inside strings', () => {
        const result = stripJsoncComments('{ "url": "http://example.com" }');
        assert.equal(JSON.parse(result).url, 'http://example.com');
    });

    it('returns empty string for empty input', () => {
        assert.equal(stripJsoncComments(''), '');
    });

    it('handles trailing commas', () => {
        const jsonc = '{ "a": 1, "b": 2, }';
        const result = stripJsoncComments(jsonc);
        const parsed = JSON.parse(result);
        assert.equal(parsed.a, 1);
        assert.equal(parsed.b, 2);
    });

    it('handles JSONC with both comments and trailing commas', () => {
        const jsonc = [
            '{',
            '  // this is a comment',
            '  "editor.fontSize": 14,',
            '  "files.exclude": {',
            '    "**/.git": true, // trailing comma',
            '  },',
            '}'
        ].join('\n');
        const result = stripJsoncComments(jsonc);
        const parsed = JSON.parse(result);
        assert.equal(parsed['editor.fontSize'], 14);
        assert.equal(parsed['files.exclude']['**/.git'], true);
    });

    it('preserves comma-bracket sequences inside strings', () => {
        const input = '{ "text": ",}", "n": 1 }';
        const result = stripJsoncComments(input);
        const parsed = JSON.parse(result);
        assert.equal(parsed.text, ',}', 'comma-bracket inside string must not be altered');
        assert.equal(parsed.n, 1);
    });
});
