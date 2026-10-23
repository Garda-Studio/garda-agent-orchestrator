import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PROJECT_MEMORY_INIT_REFRESH_PROMPT } from '../../src/core/project-memory-rollout';

const AGENT_INIT_CONTRACT_MARKERS = [
    '<!-- garda:agent-init-contract:task-execution -->',
    '<!-- garda:agent-init-contract:usage-report -->'
] as const;

function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'AGENT_INIT_PROMPT.md'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

test('AGENT_INIT_PROMPT requires explicit active-agent-files confirmation', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /you must ask the user which agent entrypoint files are actively used/i);
    assert.match(content, /Never silently infer or expand `ActiveAgentFiles`\./);
    assert.match(content, /present supported entrypoint files as explicit ready-made selectable options/i);
    assert.match(content, /QWEN\.md/i);
    assert.match(content, /do not collapse this required question into only `Only <canonical>` plus a generic `Type your answer` fallback/i);
    assert.doesNotMatch(content, /decide yourself whether additional managed entrypoint files are actually needed/i);
});

test('AGENT_INIT_PROMPT avoids duplicate active-agent-files follow-up after step-2 confirmation', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /treat that answer as satisfying the mandatory `ActiveAgentFiles` question in step 3 and do not ask the identical file-list prompt again/i);
    assert.match(content, /Only ask the `ActiveAgentFiles` question in this step if `<active-agent-files>` has not already been explicitly confirmed in step 2\./i);
    assert.match(content, /If step 2 already collected `<active-agent-files>`, reuse that answer here and continue to the next missing mandatory question instead of repeating the same list-selection prompt\./i);
    assert.match(content, /the agent may ask at most one follow-up selection question after `multiple`; once the user has provided the supported file list, do not repeat the identical file-list prompt\./i);
});

test('AGENT_INIT_PROMPT promotes CollectedVia to AGENT_INIT_PROMPT on language or agent-file clarification', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /set `CollectedVia` to `AGENT_INIT_PROMPT\.md` if the agent had to collect one or more missing mandatory answers, clarify `AssistantLanguage`, or ask\/confirm `ActiveAgentFiles`\./);
});

test('AGENT_INIT_PROMPT requires the hard agent-init command before declaring readiness', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /node garda-agent-orchestrator\/bin\/garda\.js agent-init/);
    assert.match(content, /Never declare the workspace ready until `node garda-agent-orchestrator\/bin\/garda\.js agent-init/i);
});

test('AGENT_INIT_PROMPT routes project-memory enrichment to source files', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /Enrich project memory from real repository evidence/i);
    assert.ok(content.includes(PROJECT_MEMORY_INIT_REFRESH_PROMPT));
    assert.match(content, /compact project map for orientation, not proof/i);
    assert.match(content, /Task ids are optional provenance only/i);
    assert.match(content, /not be the default heading structure/i);
    assert.match(content, /garda-agent-orchestrator\/live\/docs\/project-memory\/README\.md/);
    assert.match(content, /garda-agent-orchestrator\/live\/docs\/project-memory\/compact\.md/);
    assert.match(content, /do not edit `garda-agent-orchestrator\/live\/docs\/agent-rules\/15-project-memory\.md` directly/i);
    assert.match(content, /do not invent domain architecture, stack details, commands, or ownership boundaries/i);
    assert.match(content, /unknown or custom/i);
    assert.match(content, /placeholder-heavy memory requires explicit, actionable warning/i);
});

test('AGENT_INIT_PROMPT keeps onboarding edits out of task mode', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /These onboarding edits are not a task: edit the rule and project-memory files directly/);
    assert.match(content, /Do not add a `TASK\.md` row, run `enter-task-mode`, or ask the user to relax the Garda self-guard/);
    assert.match(PROJECT_MEMORY_INIT_REFRESH_PROMPT, /do not add a TASK\.md task or enter task mode for initialization/);
    assert.ok(!content.includes('through the normal orchestrator workflow'));
});

test('CLI reference keeps project-memory init-refresh prompt synchronized', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'docs', 'cli-reference.md'), 'utf8');
    assert.ok(content.includes(PROJECT_MEMORY_INIT_REFRESH_PROMPT));
    assert.match(content, /ProjectMemoryInitialized=false/);
    assert.match(content, /ProjectMemoryValidated=false/);
    assert.match(content, /ProjectMemoryInitRefreshPrompt/);
    assert.match(content, /AGENT_STATE_INVALID/);
    assert.match(content, /do not by themselves set the top-level `init_refresh_prompt`/);
    assert.match(content, /does not recommend the expensive full init\/refresh prompt again/i);
});

test('README explains first-run and update project-memory initialization handoff', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'README.md'), 'utf8');
    assert.match(content, /initializes or refreshes project memory from repository evidence/i);
    assert.match(content, /After CLI setup or update/i);
    assert.match(content, /Setup and update reports always include the canonical project-memory init\/refresh handoff prompt/i);
    assert.match(content, /`garda status` and `garda preprompt task` surface the state-gated project-memory init\/refresh prompt/i);
    assert.match(content, /ProjectMemoryInitialized=true/);
    assert.match(content, /ProjectMemoryValidated=true/);
    assert.match(content, /Malformed agent-init state is reported as invalid first/i);
    assert.match(content, /does not ask for full memory initialization again/i);
});

test('AGENT_INIT_PROMPT requires explicit code-style policy for empty repositories', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /ask the user a mandatory code-style policy question/i);
    assert.match(content, /use common best practices instead of copying weak, inconsistent, or legacy code patterns/i);
    assert.match(content, /do not treat inconsistent or obviously low-quality existing code as automatic style source of truth/i);
    assert.match(content, /localized equivalent of `StylePolicy \(answer must be exactly one token: default or custom\):`/i);
    assert.match(content, /localized equivalent of `Choose style-policy for `30-code-style\.md`:`/i);
    assert.match(content, /answer tokens must remain exactly `default` and `custom`/i);
    assert.match(content, /explain in `<assistant-language>` that this choice decides whether Garda writes only the default code-style priority rule now or also captures extra repository-specific style rules now/i);
    assert.match(content, /concise example answer line in `<assistant-language>` that still shows the machine-safe final answer as exactly one token/i);
    assert.match(content, /Example answer: default/i);
    assert.match(content, /Example answer: custom/i);
    assert.match(content, /do not ask the style-policy question as the English literal `Choose style-policy for `30-code-style\.md`: default\|custom` unless `<assistant-language>` is English/i);
    assert.match(content, /Present the answer tokens visibly in the prompt as `default\|custom`\./i);
    assert.doesNotMatch(content, /Ask with this exact shape:/i);
    assert.match(content, /The user accepted the default policy for this repository: follow explicit project rules first, formatter\/linter\/static-analysis rules second/i);
});

test('AGENT_INIT_PROMPT explains ordinary document paths before confirmation', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    assert.match(content, /ordinary document paths are ordinary planning, status, changelog, roadmap, or product documentation path patterns/i);
    assert.match(content, /lighter documentation-impact routing instead of code\/test review/i);
    assert.match(content, /confirm the proposed `ordinary_doc_paths` list/i);
    assert.match(content, /concise example answer in `<assistant-language>`, such as `CHANGELOG\.md,docs\/plan\.md`/i);
    assert.match(content, /empty answer means no ordinary document path exceptions should be persisted/i);
    assert.match(content, /matched files still appear in preflight\/doc-impact evidence/i);
    assert.match(content, /not a global ignore list/i);
    assert.match(content, /not a way to hide files from the agent/i);
    assert.match(content, /not a bypass for protected control-plane docs, runtime code, config\/dependency\/security\/API\/database surfaces, or mixed source changes/i);
    assert.match(content, /`agent-init --ordinary-doc-paths` argument/i);
    assert.match(content, /Scan the repository yourself before asking/);
    assert.match(content, /Show the found candidates as a numbered list with a short note for each, mark your recommended set/);
    assert.match(content, /gets a light documentation check instead of code and test reviews/);
});

test('AGENT_INIT_PROMPT distinguishes optional packs from already available skills', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    const skillsCheckpointIndex = content.indexOf('Required optional-specialist-skills checkpoint before finalization');
    const finalAgentInitIndex = content.indexOf('Finalize agent initialization through the hard code-level gate');

    assert.ok(skillsCheckpointIndex > -1);
    assert.ok(finalAgentInitIndex > -1);
    assert.ok(skillsCheckpointIndex < finalAgentInitIndex);
    assert.match(content, /This checkpoint is mandatory even though installing extra skills is optional/i);
    assert.match(content, /Do not run `agent-init` before the user has seen the specialist-skills summary and answered the yes\/no question/i);
    assert.match(content, /built-in pack = installable bundle of optional skills/i);
    assert.match(content, /explicitly list baseline skills already available now/i);
    assert.match(content, /recommend only optional packs and optional skills that are not already available/i);
    assert.match(content, /Do you want to add additional specialist skills now\? \(yes\/no\)/i);
    assert.match(content, /If the user answers `no`, do not install anything; record that the question was shown by using `--skills-prompted yes`/i);
    assert.match(content, /`--skills-prompted false` or `--skills-prompted no` means the specialist-skills question was not completed/i);
    assert.match(content, /show the `Suggested Optional Packs To Add` from `skills suggest` as a numbered list/);
    assert.match(content, /Never ask the bare yes\/no question without the numbered list/);
    assert.match(content, /if the user answers `yes` without numbers, install the recommended set/);
});

test('AGENT_INIT_PROMPT keeps the task execution contract navigator-first', () => {
    const content = fs.readFileSync(path.join(findRepoRoot(), 'AGENT_INIT_PROMPT.md'), 'utf8');
    for (const marker of AGENT_INIT_CONTRACT_MARKERS) {
        assert.ok(content.includes(marker), `AGENT_INIT_PROMPT.md should include ${marker}`);
    }
    assert.ok(content.includes('Execute task <task-id> from TASK.md strictly through the orchestrator.'));
    assert.ok(content.includes('next-step "<task-id>" --repo-root "."'));
    assert.ok(content.includes('garda-agent-orchestrator/live/config/profiles.json'));
    assert.ok(content.includes('profile current|list|use|create --target-root "."'));
    assert.ok(content.includes('workflow set --full-suite-enabled true --full-suite-command "<project test command>"'));
    assert.ok(content.includes('garda-agent-orchestrator/'));
    assert.doesNotMatch(content, /default depth when omitted:\s*`2`/i);
});
