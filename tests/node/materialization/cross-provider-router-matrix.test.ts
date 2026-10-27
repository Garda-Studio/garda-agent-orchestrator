import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SOURCE_OF_TRUTH_VALUES, SOURCE_TO_ENTRYPOINT_MAP, ALL_AGENT_ENTRYPOINT_FILES } from '../../../src/core/constants';
import {
    getCanonicalEntrypointFile,
    getActiveAgentEntrypointFiles,
    getProviderOrchestratorProfileDefinitions,
    getGitHubSkillBridgeProfileDefinitions,
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
} from '../../../src/materialization/common';
import {
    MANAGED_START,
    MANAGED_END,
    buildCanonicalManagedBlock,
    buildRedirectManagedBlock,
    buildProviderOrchestratorAgentContent,
    buildSharedStartTaskWorkflowContent,
    buildGitHubSkillBridgeAgentContent,
    ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION
} from '../../../src/materialization/content-builders';
import {
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION,
    REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
    REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION
} from '../../../src/gate-runtime/reviewer-session-contract';
import { formatProviderIdList } from '../../../src/core/provider-registry';


import * as fs from 'node:fs';
import * as path from 'node:path';

const CANONICAL_RULE_INDEX_TEMPLATE_PATH = path.join(process.cwd(), 'template', 'entrypoints', 'canonical-rule-index.md');
const canonicalRuleIndexTemplateContent = fs.readFileSync(CANONICAL_RULE_INDEX_TEMPLATE_PATH, 'utf-8');

const ALL_PROVIDERS = SOURCE_OF_TRUTH_VALUES as readonly string[];
const PROVIDER_BRIDGE_PROFILES = getProviderOrchestratorProfileDefinitions();
const SKILL_BRIDGE_PROFILES = getGitHubSkillBridgeProfileDefinitions();

/** Providers that have an orchestrator bridge profile (directory-scoped). */
const BRIDGE_PROVIDER_LABELS = PROVIDER_BRIDGE_PROFILES.map((p) => p.providerLabel);

/** All orchestrator bridge relative paths. */
const BRIDGE_PATHS = PROVIDER_BRIDGE_PROFILES.map((p) => p.orchestratorRelativePath);

// Shared contract fragments that must appear across surfaces.
const MANDATORY_GATE_SEQUENCE = [
    'gate enter-task-mode',
    'gate load-rule-pack',
    'gate handshake-diagnostics',
    'gate shell-smoke-preflight',
    'gate classify-change',
    'gate compile-gate',
    'gate build-review-context',
    'gate required-reviews-check',
    'gate doc-impact-gate',
    'gate completion-gate'
];

// ===========================================================================
// 1. Root-entrypoint-only flows
// ===========================================================================

describe('cross-provider-router-matrix: root-entrypoint canonical blocks', () => {
    for (const provider of ALL_PROVIDERS) {
        const canonicalFile = getCanonicalEntrypointFile(provider);

        it(`${provider}: canonical block contains managed markers`, () => {
            const block = buildCanonicalManagedBlock(canonicalFile, canonicalRuleIndexTemplateContent);
            assert.ok(block.includes(MANAGED_START), `Missing start marker for ${provider}`);
            assert.ok(block.includes(MANAGED_END), `Missing end marker for ${provider}`);
        });

        it(`${provider}: canonical block title matches entrypoint file`, () => {
            const block = buildCanonicalManagedBlock(canonicalFile, canonicalRuleIndexTemplateContent);
            assert.ok(
                block.includes(`# ${canonicalFile}`),
                `Title should be '# ${canonicalFile}', got block starting with: ${block.slice(0, 200)}`
            );
        });

        it(`${provider}: canonical block references all 12 rule files`, () => {
            const block = buildCanonicalManagedBlock(canonicalFile, canonicalRuleIndexTemplateContent);
            const ruleFiles = [
                '00-core.md', '10-project-context.md', '15-project-memory.md',
                '20-architecture.md', '30-code-style.md', '35-strict-coding-rules.md',
                '40-commands.md', '50-structure-and-docs.md', '60-operating-rules.md',
                '70-security.md', '80-task-workflow.md', '90-skill-catalog.md'
            ];
            for (const rf of ruleFiles) {
                assert.ok(
                    block.includes(rf),
                    `${provider} canonical block missing rule file reference: ${rf}`
                );
            }
        });

        it(`${provider}: canonical block uses navigator-first task-start contract`, () => {
            const block = buildCanonicalManagedBlock(canonicalFile, canonicalRuleIndexTemplateContent);
            assert.ok(block.includes('Execute task <task-id> from TASK.md strictly through the orchestrator.'));
            assert.ok(block.includes('Use `next-step` as the navigator'));
            assert.ok(block.includes('launch a sub-agent using your internal tools'));
            assert.ok(block.includes('do not present `depth=<1|2|3>` as normal user task-start guidance'));
            assert.ok(!block.includes('strictly through all mandatory orchestrator gates'));
            assert.ok(!block.includes('Active profile is the default execution mode'));
        });

        it(`${provider}: canonical block includes Hard Stop section with TASK.md reference`, () => {
            const block = buildCanonicalManagedBlock(canonicalFile, canonicalRuleIndexTemplateContent);
            assert.ok(block.includes('Hard Stop'), `${provider}: missing Hard Stop section`);
            assert.ok(block.includes('TASK.md'), `${provider}: missing TASK.md reference`);
        });

        it(`${provider}: canonical block references shared start-task router`, () => {
            const block = buildCanonicalManagedBlock(canonicalFile, canonicalRuleIndexTemplateContent);
            assert.ok(
                block.includes('.agents/workflows/start-task.md'),
                `${provider}: canonical block must reference shared start-task router`
            );
        });

        it(`${provider}: canonical block renders provider list from registry`, () => {
            const block = buildCanonicalManagedBlock(canonicalFile, canonicalRuleIndexTemplateContent);
            assert.ok(block.includes(`(\`${formatProviderIdList('`, `')}\`)`));
            assert.ok(!block.includes('{{SOURCE_OF_TRUTH_VALUES}}'));
        });

        it(`${provider}: canonical block references all provider bridge paths`, () => {
            const block = buildCanonicalManagedBlock(canonicalFile, canonicalRuleIndexTemplateContent);
            for (const bp of BRIDGE_PATHS) {
                assert.ok(
                    block.includes(bp),
                    `${provider}: canonical block missing bridge path: ${bp}`
                );
            }
        });

        it(`${provider}: canonical block includes Rule Routing table`, () => {
            const block = buildCanonicalManagedBlock(canonicalFile, canonicalRuleIndexTemplateContent);
            assert.ok(block.includes('## Rule Routing'), `${provider}: missing Rule Routing section`);
            assert.ok(block.includes('| Task context |'), `${provider}: missing routing table header`);
        });
    }
});

// ===========================================================================
// 2. Redirect (non-canonical) entrypoint flows
// ===========================================================================

describe('cross-provider-router-matrix: redirect entrypoint blocks', () => {
    for (const provider of ALL_PROVIDERS) {
        const canonicalFile = getCanonicalEntrypointFile(provider);

        for (const otherProvider of ALL_PROVIDERS) {
            if (otherProvider === provider) continue;
            const otherFile = getCanonicalEntrypointFile(otherProvider);

            it(`${otherProvider} redirects to ${provider} canonical (${canonicalFile})`, () => {
                const redirect = buildRedirectManagedBlock(otherFile, canonicalFile, BRIDGE_PATHS);
                assert.ok(redirect.includes(MANAGED_START));
                assert.ok(redirect.includes(MANAGED_END));
                assert.ok(redirect.includes(`# ${otherFile}`), `Redirect title should be ${otherFile}`);
                assert.ok(redirect.includes(canonicalFile), `Redirect must reference canonical ${canonicalFile}`);
                assert.ok(redirect.includes('redirect'), 'Redirect block must mention "redirect"');
            });
        }
    }

    it('redirect block references shared start-task router', () => {
        const redirect = buildRedirectManagedBlock('AGENTS.md', 'CLAUDE.md', BRIDGE_PATHS);
        assert.ok(redirect.includes('.agents/workflows/start-task.md'));
    });

    it('redirect block includes all provider bridge lines when bridges given', () => {
        const redirect = buildRedirectManagedBlock('GEMINI.md', 'CLAUDE.md', BRIDGE_PATHS);
        for (const providerLabel of BRIDGE_PROVIDER_LABELS) {
            assert.ok(redirect.includes(providerLabel), `Redirect block missing bridge provider ${providerLabel}`);
        }
    });

    it('redirect block shows no-bridge message when empty', () => {
        const redirect = buildRedirectManagedBlock('GEMINI.md', 'CLAUDE.md', []);
        assert.ok(redirect.includes('No provider-specific bridge files'));
    });

    it('redirect includes orchestration mandate lines', () => {
        const redirect = buildRedirectManagedBlock('AGENTS.md', 'CLAUDE.md', []);
        assert.ok(redirect.includes('gate load-rule-pack'));
        assert.ok(redirect.includes('gate build-review-context'));
        assert.ok(redirect.includes('orchestration control-plane files'));
        assert.ok(redirect.includes('start marker'));
        assert.ok(redirect.includes('Garda captures my mind'));
        assert.ok(redirect.includes('Execute task <task-id> from TASK.md strictly through the orchestrator.'));
        assert.ok(redirect.includes('Use `next-step` as the navigator'));
    });
});

// ===========================================================================
// 3. Provider-bridge flows
// ===========================================================================

describe('cross-provider-router-matrix: provider orchestrator bridges', () => {
    for (const profile of PROVIDER_BRIDGE_PROFILES) {
        const { providerLabel, orchestratorRelativePath } = profile;

        for (const sot of ALL_PROVIDERS) {
            const canonicalFile = getCanonicalEntrypointFile(sot);

            it(`${providerLabel} bridge (SoT=${sot}): references canonical ${canonicalFile}`, () => {
                const content = buildProviderOrchestratorAgentContent(
                    providerLabel, canonicalFile, orchestratorRelativePath
                );
                assert.ok(content.includes(canonicalFile));
            });

            it(`${providerLabel} bridge (SoT=${sot}): contains managed markers`, () => {
                const content = buildProviderOrchestratorAgentContent(
                    providerLabel, canonicalFile, orchestratorRelativePath
                );
                assert.ok(content.includes(MANAGED_START));
                assert.ok(content.includes(MANAGED_END));
            });

            it(`${providerLabel} bridge (SoT=${sot}): references shared start-task router`, () => {
                const content = buildProviderOrchestratorAgentContent(
                    providerLabel, canonicalFile, orchestratorRelativePath
                );
                assert.ok(
                    content.includes('.agents/workflows/start-task.md'),
                    `${providerLabel} bridge missing shared start-task router reference`
                );
            });

            it(`${providerLabel} bridge (SoT=${sot}): references TASK.md`, () => {
                const content = buildProviderOrchestratorAgentContent(
                    providerLabel, canonicalFile, orchestratorRelativePath
                );
                assert.ok(content.includes('TASK.md'));
                assert.ok(content.includes('start marker'));
                assert.ok(content.includes('Garda captures my mind'));
            });

            it(`${providerLabel} bridge (SoT=${sot}): references orchestration skill`, () => {
                const content = buildProviderOrchestratorAgentContent(
                    providerLabel, canonicalFile, orchestratorRelativePath
                );
                assert.ok(
                    content.includes('garda-agent-orchestrator/live/skills/orchestration/SKILL.md'),
                    `${providerLabel} bridge missing orchestration skill reference`
                );
            });
        }
    }

    it('non-Antigravity bridges include Required Execution Contract section', () => {
        const nonAntigravity = PROVIDER_BRIDGE_PROFILES.filter(
            (p) => p.orchestratorRelativePath !== '.antigravity/agents/orchestrator.md'
        );
        for (const profile of nonAntigravity) {
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(
                content.includes('## Required Execution Contract'),
                `${profile.providerLabel} bridge missing Required Execution Contract`
            );
        }
    });

    it('Antigravity bridge uses compact router format', () => {
        const antigravity = PROVIDER_BRIDGE_PROFILES.find(
            (p) => p.orchestratorRelativePath === '.antigravity/agents/orchestrator.md'
        )!;
        const content = buildProviderOrchestratorAgentContent(
            antigravity.providerLabel, 'CLAUDE.md', antigravity.orchestratorRelativePath
        );
        assert.ok(content.includes('Antigravity Agent: Orchestrator'));
        assert.ok(content.includes('delegated_subagent'));
        assert.ok(content.includes('stale fallback metadata cannot satisfy a fresh cycle'));
        assert.ok(content.includes(ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION));
        assert.ok(!content.includes('## Required Execution Contract'));
        assert.ok(content.includes('.agents/workflows/start-task.md'));
    });

    it('non-Antigravity bridges include Skill Routing section', () => {
        const nonAntigravity = PROVIDER_BRIDGE_PROFILES.filter(
            (p) => p.orchestratorRelativePath !== '.antigravity/agents/orchestrator.md'
        );
        for (const profile of nonAntigravity) {
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(content.includes('## Skill Routing'), `${profile.providerLabel} missing Skill Routing`);
            assert.ok(content.includes('code-review/SKILL.md'));
            assert.ok(content.includes('db-review/SKILL.md'));
            assert.ok(content.includes('security-review/SKILL.md'));
            assert.ok(content.includes('refactor-review/SKILL.md'));
        }
    });

    it('non-Antigravity bridges include Dynamic Skill Discovery section', () => {
        const nonAntigravity = PROVIDER_BRIDGE_PROFILES.filter(
            (p) => p.orchestratorRelativePath !== '.antigravity/agents/orchestrator.md'
        );
        for (const profile of nonAntigravity) {
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(content.includes('90-skill-catalog.md'));
            assert.ok(content.includes('review-capabilities.json'));
            assert.ok(content.includes('token-economy.json'));
            assert.ok(content.includes('output-filters.json'));
        }
    });

    it('non-Antigravity bridges include Reviewer Launch Mapping', () => {
        const nonAntigravity = PROVIDER_BRIDGE_PROFILES.filter(
            (p) => p.orchestratorRelativePath !== '.antigravity/agents/orchestrator.md'
        );
        for (const profile of nonAntigravity) {
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(content.includes('Reviewer Launch Mapping'));
            assert.ok(content.includes('delegation'));
        }
    });

    it('all provider bridges reject stale same_agent_fallback wording', () => {
        for (const profile of PROVIDER_BRIDGE_PROFILES) {
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(!content.includes('same_agent_fallback'), `${profile.providerLabel} reintroduced same_agent_fallback wording`);
        }
    });

    it('non-Antigravity bridges pin delegated-only receipt wording', () => {
        const nonAntigravity = PROVIDER_BRIDGE_PROFILES.filter(
            (p) => p.orchestratorRelativePath !== '.antigravity/agents/orchestrator.md'
        );
        for (const profile of nonAntigravity) {
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(content.includes('reviewer_execution_mode'), `${profile.providerLabel} missing reviewer_execution_mode contract`);
            assert.ok(content.includes('delegated_subagent'), `${profile.providerLabel} missing delegated_subagent contract`);
            assert.ok(content.includes('reviewer_identity'), `${profile.providerLabel} missing reviewer_identity contract`);
            assert.ok(
                content.includes('cannot satisfy a fresh mandatory review cycle'),
                `${profile.providerLabel} missing delegated-only receipt durability wording`
            );
        }
    });

    it('all provider bridges pin fresh reviewer launch and cleanup wording', () => {
        for (const profile of PROVIDER_BRIDGE_PROFILES) {
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(
                content.includes(REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION),
                `${profile.providerLabel} missing fresh reviewer launch instruction`
            );
            assert.ok(
                content.includes(REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION),
                `${profile.providerLabel} missing reviewer session reuse boundary`
            );
            assert.ok(
                content.includes(REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION),
                `${profile.providerLabel} missing reviewer cleanup instruction`
            );
        }
    });

    it('bridge path self-reference is present for each provider', () => {
        for (const profile of PROVIDER_BRIDGE_PROFILES) {
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(
                content.includes(profile.orchestratorRelativePath),
                `${profile.providerLabel} bridge missing self-reference to ${profile.orchestratorRelativePath}`
            );
        }
    });

    it('non-Antigravity bridges include POST_PREFLIGHT rule-pack reload step', () => {
        const nonAntigravity = PROVIDER_BRIDGE_PROFILES.filter(
            (p) => p.orchestratorRelativePath !== '.antigravity/agents/orchestrator.md'
        );
        for (const profile of nonAntigravity) {
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(
                content.includes('POST_PREFLIGHT'),
                `${profile.providerLabel} bridge missing POST_PREFLIGHT rule-pack reload`
            );
        }
    });
});

// ===========================================================================
// 4. Shared start-task workflow router
// ===========================================================================

describe('cross-provider-router-matrix: shared start-task workflow', () => {
    for (const provider of ALL_PROVIDERS) {
        const canonicalFile = getCanonicalEntrypointFile(provider);

        it(`SoT=${provider}: shared workflow references canonical file ${canonicalFile}`, () => {
            const content = buildSharedStartTaskWorkflowContent(canonicalFile);
            assert.ok(content.includes(canonicalFile));
        });

        it(`SoT=${provider}: shared workflow contains managed markers`, () => {
            const content = buildSharedStartTaskWorkflowContent(canonicalFile);
            assert.ok(content.includes(MANAGED_START));
            assert.ok(content.includes(MANAGED_END));
        });

        it(`SoT=${provider}: shared workflow contains mandatory gate sequence`, () => {
            const content = buildSharedStartTaskWorkflowContent(canonicalFile);
            for (const gate of MANDATORY_GATE_SEQUENCE) {
                assert.ok(
                    content.includes(gate),
                    `SoT=${provider}: shared workflow missing gate reference: ${gate}`
                );
            }
        });

        it(`SoT=${provider}: shared workflow includes POST_PREFLIGHT rule-pack reload step`, () => {
            const content = buildSharedStartTaskWorkflowContent(canonicalFile);
            assert.ok(
                content.includes('load-rule-pack') && content.includes('POST_PREFLIGHT'),
                `SoT=${provider}: shared workflow missing POST_PREFLIGHT rule-pack reload`
            );
        });

        it(`SoT=${provider}: shared workflow references TASK.md`, () => {
            const content = buildSharedStartTaskWorkflowContent(canonicalFile);
            assert.ok(content.includes('TASK.md'));
        });

        it(`SoT=${provider}: shared workflow includes hard stops`, () => {
            const content = buildSharedStartTaskWorkflowContent(canonicalFile);
            assert.ok(content.includes('COMPLETION_GATE_PASSED'));
            assert.ok(content.includes('Hard stop'));
        });
    }

    it('shared workflow has YAML frontmatter description', () => {
        const content = buildSharedStartTaskWorkflowContent('CLAUDE.md');
        assert.ok(content.includes('description:'));
        assert.ok(content.includes('shared router'));
    });
});

// ===========================================================================
// 5. GitHub skill bridge coverage
// ===========================================================================

describe('cross-provider-router-matrix: GitHub skill bridges', () => {
    it('covers all 10 expected skill bridge profiles', () => {
        assert.equal(SKILL_BRIDGE_PROFILES.length, 10);
    });

    const expectedSkills = [
        { keyword: 'reviewer', skillFragment: 'orchestration/SKILL.md' },
        { keyword: 'code-review', skillFragment: 'code-review/SKILL.md' },
        { keyword: 'db-review', skillFragment: 'db-review/SKILL.md' },
        { keyword: 'security-review', skillFragment: 'security-review/SKILL.md' },
        { keyword: 'refactor-review', skillFragment: 'refactor-review/SKILL.md' },
        { keyword: 'api-review', skillFragment: 'api-contract-review/SKILL.md' },
        { keyword: 'test-review', skillFragment: 'testing-strategy/SKILL.md' },
        { keyword: 'performance-review', skillFragment: 'performance-review/SKILL.md' },
        { keyword: 'infra-review', skillFragment: 'devops-k8s/SKILL.md' },
        { keyword: 'dependency-review', skillFragment: 'dependency-review/SKILL.md' }
    ];

    for (const expected of expectedSkills) {
        it(`skill bridge for ${expected.keyword} exists and references correct skill`, () => {
            const profile = SKILL_BRIDGE_PROFILES.find(
                (p) => p.relativePath.includes(expected.keyword)
            );
            assert.ok(profile, `Missing skill bridge profile for ${expected.keyword}`);
            assert.ok(
                profile!.skillPath.includes(expected.skillFragment),
                `${expected.keyword} skill path mismatch: got ${profile!.skillPath}`
            );
        });
    }

    for (const sot of ALL_PROVIDERS) {
        const canonicalFile = getCanonicalEntrypointFile(sot);

        it(`skill bridges reference canonical ${canonicalFile} when SoT=${sot}`, () => {
            for (const profile of SKILL_BRIDGE_PROFILES) {
                const content = buildGitHubSkillBridgeAgentContent(
                    profile.profileTitle, canonicalFile,
                    profile.skillPath, profile.reviewRequirement, profile.capabilityFlag
                );
                assert.ok(
                    content.includes(canonicalFile),
                    `Skill bridge ${profile.profileTitle} (SoT=${sot}) missing canonical file reference`
                );
            }
        });
    }

    it('all skill bridges contain managed markers', () => {
        for (const profile of SKILL_BRIDGE_PROFILES) {
            const content = buildGitHubSkillBridgeAgentContent(
                profile.profileTitle, 'CLAUDE.md',
                profile.skillPath, profile.reviewRequirement, profile.capabilityFlag
            );
            assert.ok(content.includes(MANAGED_START));
            assert.ok(content.includes(MANAGED_END));
        }
    });

    it('all skill bridges include Skill Bridge Contract section', () => {
        for (const profile of SKILL_BRIDGE_PROFILES) {
            const content = buildGitHubSkillBridgeAgentContent(
                profile.profileTitle, 'CLAUDE.md',
                profile.skillPath, profile.reviewRequirement, profile.capabilityFlag
            );
            assert.ok(content.includes('## Skill Bridge Contract'));
            assert.ok(content.includes('90-skill-catalog.md'));
            assert.ok(content.includes('review-capabilities.json'));
            assert.ok(content.includes('build-review-context'));
        }
    });

    it('all skill bridges reference .github/agents/orchestrator.md', () => {
        for (const profile of SKILL_BRIDGE_PROFILES) {
            const content = buildGitHubSkillBridgeAgentContent(
                profile.profileTitle, 'CLAUDE.md',
                profile.skillPath, profile.reviewRequirement, profile.capabilityFlag
            );
            assert.ok(content.includes('.github/agents/orchestrator.md'));
        }
    });

    it('all skill bridges forbid marking DONE from skill profile', () => {
        for (const profile of SKILL_BRIDGE_PROFILES) {
            const content = buildGitHubSkillBridgeAgentContent(
                profile.profileTitle, 'CLAUDE.md',
                profile.skillPath, profile.reviewRequirement, profile.capabilityFlag
            );
            assert.ok(
                content.includes('Never mark') && content.includes('DONE'),
                `${profile.profileTitle} missing DONE prohibition`
            );
        }
    });
});

// ===========================================================================
// 6. Mixed active-agent setups
// ===========================================================================

describe('cross-provider-router-matrix: mixed active-agent setups', () => {
    it('single provider produces single-element active list', () => {
        for (const sot of ALL_PROVIDERS) {
            const files = getActiveAgentEntrypointFiles('', sot);
            assert.equal(files.length, 1);
            assert.equal(files[0], getCanonicalEntrypointFile(sot));
        }
    });

    it('two providers produce ordered active list', () => {
        const files = getActiveAgentEntrypointFiles('AGENTS.md, CLAUDE.md', 'Claude');
        assert.equal(files.length, 2);
        assert.equal(files[0], 'CLAUDE.md');
        assert.equal(files[1], 'AGENTS.md');
    });

    it('all providers can coexist in active list', () => {
        const allFiles = ALL_AGENT_ENTRYPOINT_FILES.join(', ');
        const files = getActiveAgentEntrypointFiles(allFiles, 'Claude');
        assert.equal(files.length, ALL_AGENT_ENTRYPOINT_FILES.length);
    });

    it('mixed setup: each active file produces valid canonical or redirect', () => {
        const active = getActiveAgentEntrypointFiles(
            'CLAUDE.md, AGENTS.md, .github/copilot-instructions.md', 'Claude'
        );
        const canonicalFile = 'CLAUDE.md';

        for (const file of active) {
            if (file === canonicalFile) {
                const block = buildCanonicalManagedBlock(file, canonicalRuleIndexTemplateContent);
                assert.ok(block.includes(`# ${file}`));
            } else {
                const redirect = buildRedirectManagedBlock(file, canonicalFile, BRIDGE_PATHS);
                assert.ok(redirect.includes(`# ${file}`));
                assert.ok(redirect.includes(canonicalFile));
            }
        }
    });

    it('canonical entrypoint always includes all bridge paths regardless of active set', () => {
        const block = buildCanonicalManagedBlock('QWEN.md', canonicalRuleIndexTemplateContent);
        for (const bp of BRIDGE_PATHS) {
            assert.ok(block.includes(bp), `Canonical QWEN.md missing bridge path: ${bp}`);
        }
    });

    it('redirect entrypoints adapt bridge lines to provided bridge paths', () => {
        const singleBridge = ['.github/agents/orchestrator.md'];
        const redirect = buildRedirectManagedBlock('AGENTS.md', 'CLAUDE.md', singleBridge);
        assert.ok(redirect.includes('GitHub Copilot'));
        assert.ok(!redirect.includes('Windsurf Agent'));
        assert.ok(!redirect.includes('Junie Agent'));
    });

    it('alias-based active agent selection resolves correctly', () => {
        const files = getActiveAgentEntrypointFiles('claude, codex, copilot', 'Claude');
        assert.ok(files.includes('CLAUDE.md'));
        assert.ok(files.includes('AGENTS.md'));
        assert.ok(files.includes('.github/copilot-instructions.md'));
    });

    it('numeric-based active agent selection resolves correctly', () => {
        const files = getActiveAgentEntrypointFiles('1, 2, 5', 'Claude');
        assert.ok(files.includes('CLAUDE.md'));
        assert.ok(files.includes('AGENTS.md'));
        assert.ok(files.includes('.github/copilot-instructions.md'));
    });

    it('semicolon-separated active agent selection resolves correctly', () => {
        const files = getActiveAgentEntrypointFiles('CLAUDE.md; GEMINI.md; QWEN.md', 'Claude');
        assert.ok(files.includes('CLAUDE.md'));
        assert.ok(files.includes('GEMINI.md'));
        assert.ok(files.includes('QWEN.md'));
        assert.equal(files.length, 3);
    });

    it('mixed alias/path/number active agent selection resolves correctly', () => {
        const files = getActiveAgentEntrypointFiles('claude, 2, .windsurf/rules/rules.md', 'Junie');
        assert.ok(files.includes('CLAUDE.md'));
        assert.ok(files.includes('AGENTS.md'));
        assert.ok(files.includes('.windsurf/rules/rules.md'));
        assert.ok(files.includes('.junie/guidelines.md'));
        assert.equal(files.length, 4);
    });
});

// ===========================================================================
// 7. Drift detection: structural invariants that prevent silent weakening
// ===========================================================================

describe('cross-provider-router-matrix: drift detection', () => {
    it('SOURCE_OF_TRUTH_VALUES is registry-derived and non-empty', () => {
        assert.ok(ALL_PROVIDERS.length > 0);
        assert.equal(ALL_PROVIDERS.length, new Set(ALL_PROVIDERS).size);
    });

    it('SOURCE_TO_ENTRYPOINT_MAP covers all SOURCE_OF_TRUTH_VALUES', () => {
        for (const provider of ALL_PROVIDERS) {
            assert.ok(
                getCanonicalEntrypointFile(provider),
                `No entrypoint mapping for provider: ${provider}`
            );
        }
    });

    it('ALL_AGENT_ENTRYPOINT_FILES matches unique SOURCE_TO_ENTRYPOINT_MAP values', () => {
        const mapValues = [...new Set(Object.values(SOURCE_TO_ENTRYPOINT_MAP))];
        assert.deepEqual([...ALL_AGENT_ENTRYPOINT_FILES].sort(), [...mapValues].sort());
    });

    it('shared-entrypoint providers keep more providers than unique entrypoint files', () => {
        assert.ok(
            ALL_PROVIDERS.length > ALL_AGENT_ENTRYPOINT_FILES.length,
            'Provider count should exceed unique entrypoint file count once shared entrypoints are supported'
        );
    });

    it('every entrypoint file appears in INSTALL_BACKUP_CANDIDATE_PATHS', () => {
        // Imported separately to avoid circular dep risk; use dynamic import
        const { INSTALL_BACKUP_CANDIDATE_PATHS } = require('../../../src/materialization/content-builders');
        for (const file of ALL_AGENT_ENTRYPOINT_FILES) {
            assert.ok(
                INSTALL_BACKUP_CANDIDATE_PATHS.includes(file),
                `Entrypoint ${file} missing from INSTALL_BACKUP_CANDIDATE_PATHS`
            );
        }
    });

    it('provider bridge count matches registry-derived bridge paths', () => {
        assert.equal(PROVIDER_BRIDGE_PROFILES.length, BRIDGE_PATHS.length);
        assert.ok(PROVIDER_BRIDGE_PROFILES.length > 0);
    });

    it('every provider bridge path appears in INSTALL_BACKUP_CANDIDATE_PATHS', () => {
        const { INSTALL_BACKUP_CANDIDATE_PATHS } = require('../../../src/materialization/content-builders');
        for (const profile of PROVIDER_BRIDGE_PROFILES) {
            assert.ok(
                INSTALL_BACKUP_CANDIDATE_PATHS.includes(profile.orchestratorRelativePath),
                `Bridge ${profile.orchestratorRelativePath} missing from backup candidates`
            );
        }
    });

    it('every skill bridge path appears in INSTALL_BACKUP_CANDIDATE_PATHS', () => {
        const { INSTALL_BACKUP_CANDIDATE_PATHS } = require('../../../src/materialization/content-builders');
        for (const profile of SKILL_BRIDGE_PROFILES) {
            assert.ok(
                INSTALL_BACKUP_CANDIDATE_PATHS.includes(profile.relativePath),
                `Skill bridge ${profile.relativePath} missing from backup candidates`
            );
        }
    });

    it('shared start-task workflow path is the canonical constant', () => {
        assert.equal(SHARED_START_TASK_WORKFLOW_RELATIVE_PATH, '.agents/workflows/start-task.md');
    });

    it('canonical block includes shared start-task reference for every provider', () => {
        for (const provider of ALL_PROVIDERS) {
            const canonicalFile = getCanonicalEntrypointFile(provider);
            const block = buildCanonicalManagedBlock(canonicalFile, canonicalRuleIndexTemplateContent);
            assert.ok(
                block.includes(SHARED_START_TASK_WORKFLOW_RELATIVE_PATH),
                `${provider}: canonical block missing shared workflow reference`
            );
        }
    });

    it('redirect block includes shared start-task reference', () => {
        for (const provider of ALL_PROVIDERS) {
            const canonicalFile = getCanonicalEntrypointFile(provider);
            for (const other of ALL_PROVIDERS) {
                if (other === provider) continue;
                const otherFile = getCanonicalEntrypointFile(other);
                const redirect = buildRedirectManagedBlock(otherFile, canonicalFile, BRIDGE_PATHS);
                assert.ok(
                    redirect.includes('.agents/workflows/start-task.md'),
                    `Redirect ${otherFile}->${canonicalFile} missing start-task reference`
                );
                break; // one redirect per canonical is enough for drift detection
            }
        }
    });

    it('provider bridges match their entrypoint files in orchestrator profiles', () => {
        const entrypointToBridge = new Map(
            PROVIDER_BRIDGE_PROFILES.map((p) => [p.entrypointFile, p.orchestratorRelativePath])
        );
        assert.equal(entrypointToBridge.get('.github/copilot-instructions.md'), '.github/agents/orchestrator.md');
        assert.equal(entrypointToBridge.get('.windsurf/rules/rules.md'), '.windsurf/agents/orchestrator.md');
        assert.equal(entrypointToBridge.get('.junie/guidelines.md'), '.junie/agents/orchestrator.md');
        assert.equal(entrypointToBridge.get('.antigravity/rules.md'), '.antigravity/agents/orchestrator.md');
    });

    it('neutral canonical rule-index template managed block is valid and extractable', () => {
        const block = buildCanonicalManagedBlock('CLAUDE.md', canonicalRuleIndexTemplateContent);
        assert.ok(block.length > 500, 'Canonical block suspiciously short');
        const lines = block.split('\n');
        assert.ok(lines.length > 20, 'Canonical block has too few lines');
    });

    it('does not store CLAUDE.md as a rich source template', () => {
        assert.equal(fs.existsSync(path.join(process.cwd(), 'template', 'CLAUDE.md')), false);
    });

    it('keeps AGENTS.md as the generic root entrypoint surface', () => {
        const agentsTemplate = fs.readFileSync(path.join(process.cwd(), 'template', 'AGENTS.md'), 'utf-8');
        assert.ok(agentsTemplate.includes('# AGENTS.md'));
        assert.ok(agentsTemplate.includes('generic root entrypoint surface'));
    });

    it('gate command prefix matches the install mode across bridge content', () => {
        for (const profile of PROVIDER_BRIDGE_PROFILES) {
            if (profile.orchestratorRelativePath === '.antigravity/agents/orchestrator.md') continue;
            const deployed = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(
                deployed.includes('node garda-agent-orchestrator/bin/garda.js gate'),
                `${profile.providerLabel} bridge missing bundle gate command form`
            );
            assert.equal(deployed.includes('node bin/garda.js'), false,
                `${profile.providerLabel} installed bridge must not name the source CLI`);
            const source = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath, 'source'
            );
            assert.ok(source.includes('node bin/garda.js gate'),
                `${profile.providerLabel} source-checkout bridge missing source gate command form`);
            assert.equal(source.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode'), false,
                `${profile.providerLabel} source-checkout bridge must not route task entry to the deployed bundle`);
        }
    });

    it('no provider bridge omits the orchestration control-plane warning', () => {
        for (const profile of PROVIDER_BRIDGE_PROFILES) {
            if (profile.orchestratorRelativePath === '.antigravity/agents/orchestrator.md') continue;
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(
                content.includes('orchestration control-plane files') || content.includes('git add -f'),
                `${profile.providerLabel} bridge missing control-plane file warning`
            );
        }
    });

    it('every provider bridge states general dependent-reviewer launch discipline', () => {
        for (const profile of PROVIDER_BRIDGE_PROFILES) {
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(
                content.includes('dependent downstream reviewer'),
                `${profile.providerLabel} bridge missing dependent reviewer launch blocker`
            );
            assert.ok(
                content.includes('upstream accepted findings receipt reports findings-satisfied'),
                `${profile.providerLabel} bridge missing upstream PASS receipt requirement`
            );
            assert.ok(
                content.includes('Parallel reviewer fan-out is allowed only between independent review types'),
                `${profile.providerLabel} bridge missing independent fan-out restriction`
            );
            assert.ok(
                content.includes('Do not fan out known producer-consumer validation commands as raw shell sidecars'),
                `${profile.providerLabel} bridge missing raw-shell producer-consumer prohibition`
            );
            assert.ok(
                content.includes('a generator, build or compile step followed by a command that consumes its output'),
                `${profile.providerLabel} bridge missing concrete producer-consumer validation example`
            );
        }
    });
});

// ===========================================================================
// 8. Cross-surface contract consistency
// ===========================================================================

describe('cross-provider-router-matrix: cross-surface contract consistency', () => {
    it('every surface references TASK.md', () => {
        for (const provider of ALL_PROVIDERS) {
            const canonicalFile = getCanonicalEntrypointFile(provider);

            // Canonical entrypoint
            const canonical = buildCanonicalManagedBlock(canonicalFile, canonicalRuleIndexTemplateContent);
            assert.ok(canonical.includes('TASK.md'), `Canonical ${provider} missing TASK.md`);

            // Shared workflow
            const workflow = buildSharedStartTaskWorkflowContent(canonicalFile);
            assert.ok(workflow.includes('TASK.md'), `Shared workflow (SoT=${provider}) missing TASK.md`);
        }

        // Provider bridges
        for (const profile of PROVIDER_BRIDGE_PROFILES) {
            const content = buildProviderOrchestratorAgentContent(
                profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
            );
            assert.ok(content.includes('TASK.md'), `${profile.providerLabel} bridge missing TASK.md`);
        }

        // Skill bridges
        for (const profile of SKILL_BRIDGE_PROFILES) {
            const content = buildGitHubSkillBridgeAgentContent(
                profile.profileTitle, 'CLAUDE.md',
                profile.skillPath, profile.reviewRequirement, profile.capabilityFlag
            );
            assert.ok(content.includes('TASK.md'), `Skill bridge ${profile.profileTitle} missing TASK.md`);
        }
    });

    it('no surface omits managed block markers', () => {
        const allContents: { label: string; content: string }[] = [];

        for (const provider of ALL_PROVIDERS) {
            const cf = getCanonicalEntrypointFile(provider);
            allContents.push({
                label: `canonical-${provider}`,
                content: buildCanonicalManagedBlock(cf, canonicalRuleIndexTemplateContent)
            });
        }

        allContents.push({
            label: 'redirect-AGENTS-to-CLAUDE',
            content: buildRedirectManagedBlock('AGENTS.md', 'CLAUDE.md', BRIDGE_PATHS)
        });

        allContents.push({
            label: 'shared-workflow',
            content: buildSharedStartTaskWorkflowContent('CLAUDE.md')
        });

        for (const profile of PROVIDER_BRIDGE_PROFILES) {
            allContents.push({
                label: `bridge-${profile.providerLabel}`,
                content: buildProviderOrchestratorAgentContent(
                    profile.providerLabel, 'CLAUDE.md', profile.orchestratorRelativePath
                )
            });
        }

        for (const profile of SKILL_BRIDGE_PROFILES) {
            allContents.push({
                label: `skill-${profile.profileTitle}`,
                content: buildGitHubSkillBridgeAgentContent(
                    profile.profileTitle, 'CLAUDE.md',
                    profile.skillPath, profile.reviewRequirement, profile.capabilityFlag
                )
            });
        }

        for (const { label, content } of allContents) {
            assert.ok(content.includes(MANAGED_START), `${label}: missing MANAGED_START`);
            assert.ok(content.includes(MANAGED_END), `${label}: missing MANAGED_END`);
        }
    });

    it('shared workflow gate sequence matches bridge execution contracts', () => {
        const workflow = buildSharedStartTaskWorkflowContent('CLAUDE.md');
        const bridge = buildProviderOrchestratorAgentContent(
            'GitHub Copilot', 'CLAUDE.md', '.github/agents/orchestrator.md'
        );

        for (const gate of MANDATORY_GATE_SEQUENCE) {
            assert.ok(workflow.includes(gate), `Shared workflow missing: ${gate}`);
        }

        // Bridge references all gate names, though some use inline mention instead of `gate X`
        const bridgeGateNames = [
            'enter-task-mode', 'load-rule-pack', 'classify-change',
            'compile-gate', 'build-review-context', 'required-reviews-check',
            'doc-impact-gate', 'completion-gate'
        ];
        for (const gateName of bridgeGateNames) {
            assert.ok(
                bridge.includes(gateName),
                `GitHub Copilot bridge missing gate name: ${gateName}`
            );
        }
    });
});
