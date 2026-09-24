import * as path from 'node:path';
import { pathExists, readTextFile } from '../../core/filesystem';
import { bindContainedDestination, writeContainedFile } from '../../core/contained-filesystem';
import {
    PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT
} from '../../core/project-memory-rollout';
import {
    buildFullSuiteDisabledGuidance,
    buildNextStepNavigatorGuidance,
    buildTaskStartNavigatorPrompt
} from '../../core/onboarding-contract';
import { resolveBundleName } from '../../core/constants';
import { buildSetupStartBannerSentence } from '../../core/orchestrator-start-banner';
import { writeProtectedControlPlaneManifest } from '../../gates/shared';
import { syncReviewCapabilities, writeSkillsIndex } from '../../runtime/skills';
import {
    buildGitignoreEntries,
    syncManagedAgentignoreActiveBlockInContent,
    syncManagedGitignoreBlockInContent
} from '../content-builders';
import {
    getProviderOrchestratorProfileDefinitions
} from '../common';
import {
    buildProjectDiscoveryLines
} from '../project-discovery';
import {
    getNodeBundleCliCommand,
    getNodeHumanCommitCommand,
    getNodeInteractiveUpdateCommand,
    getNodeNonInteractiveUpdateCommand
} from '../command-constants';
import { buildMigrationReportLines, type ProjectMemoryMigrationResult } from '../project-memory/project-memory-migration';
import type { ProjectMemoryBootstrapReport } from '../project-memory/project-memory-builder';
import { RULE_FILES } from '../rule-materialization';
import type {
    InitProjectDiscovery,
    ReviewCapabilitiesSyncResult,
    RuleSourceMapEntry,
    SourceInventory
} from './init-contracts';
import {
    buildSourceInventoryLines,
    collectSourceInventory
} from './init-filesystem';
import { getFullSuiteEnabledDiagnostic } from './init-config-stage';

interface BuildInitReportOptions {
    timestampIso: string;
    projectName: string;
    targetRoot: string;
    ruleSourceMap: RuleSourceMapEntry[];
    ruleFiles: readonly string[];
    copiedSupportDirs: number;
    configMergeStatuses: Record<string, string>;
    lang: string;
    brevity: string;
    trimmedSoT: string;
    enforceNoAutoCommit: boolean;
    tokenEconomyEnabled: boolean;
    discovery: InitProjectDiscovery;
    sourceInventory: SourceInventory;
    reviewCapabilitiesSync: ReviewCapabilitiesSyncResult | null;
    projectMemoryBootstrapReport: ProjectMemoryBootstrapReport;
    projectMemoryMaintenanceSummaryLine: string;
    projectMemoryRefreshHandoffPrompt: string;
    optionalQualityChecksNotice: string | null;
    legacyStyleGuidanceActive?: boolean;
}

interface BuildUsageOptions {
    lang: string;
    brevity: string;
    canonicalEntrypoint: string;
    enforceNoAutoCommit: boolean;
    fullSuiteValidationEnabled: boolean;
}

export interface RunInitReportingStageOptions {
    targetRoot: string;
    normalizedTarget: string;
    bundleRoot: string;
    liveRoot: string;
    dryRun: boolean;
    timestampIso: string;
    projectName: string;
    resolvedActiveEntryFiles: string[];
    providerOrchestratorProfiles: ReturnType<typeof getProviderOrchestratorProfileDefinitions>;
    claudeOrchestratorFullAccess: boolean;
    providerMinimalism: boolean;
    ruleSourceMap: RuleSourceMapEntry[];
    copiedSupportDirs: number;
    configMergeStatuses: Record<string, string>;
    lang: string;
    brevity: string;
    trimmedSoT: string;
    canonicalEntrypoint: string;
    enforceNoAutoCommit: boolean;
    tokenEconomyEnabled: boolean;
    discovery: InitProjectDiscovery;
    projectMemoryBootstrapReport: ProjectMemoryBootstrapReport;
    projectMemoryMaintenanceSummaryLine: string;
    optionalQualityChecksNotice: string | null;
    legacyStyleGuidanceActive: boolean;
    migrationResult: ProjectMemoryMigrationResult;
    materializedWorkflowConfig: Record<string, unknown>;
}

export interface InitReportingStageResult {
    sourceInventory: SourceInventory;
    reviewCapabilitiesSync: ReviewCapabilitiesSyncResult | null;
    gitignoreEntriesAdded: number;
    agentignoreUpdated: boolean;
    skillsIndexPath: string;
    sourceInventoryPath: string;
    initReportPath: string;
    projectDiscoveryPath: string;
    usagePath: string;
}

export const USAGE_CONTRACT_MARKERS = {
    executeTasks: '<!-- garda:usage-contract:execute-tasks -->',
    profilesAndConfig: '<!-- garda:usage-contract:profiles-and-config -->',
    fullSuiteValidation: '<!-- garda:usage-contract:full-suite-validation -->',
    indexingNote: '<!-- garda:usage-contract:indexing-note -->'
} as const;

function buildInitReportLines(opts: BuildInitReportOptions): string[] {
    const {
        timestampIso,
        projectName,
        targetRoot,
        ruleSourceMap,
        ruleFiles,
        copiedSupportDirs,
        configMergeStatuses,
        lang,
        brevity,
        trimmedSoT,
        enforceNoAutoCommit,
        tokenEconomyEnabled,
        discovery,
        sourceInventory,
        reviewCapabilitiesSync,
        projectMemoryBootstrapReport,
        projectMemoryMaintenanceSummaryLine,
        projectMemoryRefreshHandoffPrompt,
        optionalQualityChecksNotice,
        legacyStyleGuidanceActive
    } = opts;
    const normalized = targetRoot.replace(/\\/g, '/');
    const tick = '`';
    const stackSummary = discovery.detectedStacks.length > 0
        ? discovery.detectedStacks.join(', ')
        : 'none detected';
    const dirSummary = discovery.topLevelDirectories.length > 0
        ? discovery.topLevelDirectories.slice(0, 10).join(', ')
        : 'none detected';
    const enabledOptionalReviews = reviewCapabilitiesSync
        ? Object.entries(reviewCapabilitiesSync.capabilities)
            .filter(([key, enabled]) => !['code', 'db', 'security', 'refactor'].includes(key) && enabled)
            .map(([key]) => key)
            .sort()
        : [];

    const lines = [
        '# Init Report', '',
        `Generated at: ${timestampIso}`,
        `Project: ${projectName}`,
        `Target root: ${normalized}`, '',
        '## Summary',
        `- Rule files materialized in ${tick}${resolveBundleName()}/live/docs/agent-rules${tick}: ${ruleFiles.length}`,
        `- Support directories synced into ${tick}${resolveBundleName()}/live${tick}: ${copiedSupportDirs}`,
        '- Review capabilities config sync policy: preserve existing live values, normalize legacy keys/shapes, and fill missing keys from template.',
        `- Review capabilities config merge status: ${configMergeStatuses['review-capabilities'] || 'n/a'}`,
        '- Paths config sync policy: preserve existing live values, normalize legacy keys/shapes, and fill missing keys from template.',
        `- Paths config merge status: ${configMergeStatuses['paths'] || 'n/a'}`,
        '- Token economy config sync policy: preserve existing live values, normalize legacy keys/shapes, and fill missing keys from template.',
        `- Token economy config merge status: ${configMergeStatuses['token-economy'] || 'n/a'}`,
        '- Output filters config sync policy: preserve existing live values, normalize legacy keys/shapes, and fill missing keys from template.',
        `- Output filters config merge status: ${configMergeStatuses['output-filters'] || 'n/a'}`,
        '- Skill packs config sync policy: preserve existing live values, normalize legacy keys/shapes, and fill missing keys from template.',
        `- Skill packs config merge status: ${configMergeStatuses['skill-packs'] || 'n/a'}`,
        '- Optional skill selection policy config sync policy: preserve existing live values and fill missing keys from template.',
        `- Optional skill selection policy config merge status: ${configMergeStatuses['optional-skill-selection-policy'] || 'n/a'}`,
        '- Isolation mode config sync policy: preserve existing live values, fill missing keys from template.',
        `- Isolation mode config merge status: ${configMergeStatuses['isolation-mode'] || 'n/a'}`,
        '- Profiles config sync policy: preserve existing live values and user profiles, fill ordinary missing keys from template, and keep legacy remediation-mode policy omission FULL-only until explicit migration.',
        `- Profiles config merge status: ${configMergeStatuses['profiles'] || 'n/a'}`,
        '- Review artifact storage config sync policy: preserve existing live values, fill missing keys from template.',
        `- Review artifact storage config merge status: ${configMergeStatuses['review-artifact-storage'] || 'n/a'}`,
        '- Runtime retention config sync policy: preserve existing live values, fill missing keys from template.',
        `- Runtime retention config merge status: ${configMergeStatuses['runtime-retention'] || 'n/a'}`,
        '- Workflow config sync policy: preserve existing live values, fill missing keys from template; if the live file is missing, malformed, or non-object, apply template defaults and report the effective full-suite setting.',
        `- Workflow config merge status: ${configMergeStatuses['workflow-config'] || 'n/a'}`,
        '- Root config manifest sync policy: rewrite the canonical root manifest from template on every init/update.',
        `- Root config manifest merge status: ${configMergeStatuses['garda.config'] || 'n/a'}`,
        `- Assistant response language: ${lang}`,
        `- Assistant response brevity: ${brevity}`,
        `- Source of truth entrypoint: ${trimmedSoT}`,
        `- Hard no-auto-commit guard: ${enforceNoAutoCommit ? 'enabled' : 'disabled'}`,
        `- Token economy mode: ${tokenEconomyEnabled ? 'enabled' : 'disabled'}`,
        `- Project discovery source: ${discovery.source}`,
        `- Project discovery stack signals: ${stackSummary}`,
        `- Project discovery top-level directories: ${dirSummary}`,
        `- Legacy docs discovered in \`docs/agent-rules\`: ${sourceInventory.legacyRuleFiles.length} files`,
        `- Optional review capabilities enabled from live skills: ${enabledOptionalReviews.length > 0 ? enabledOptionalReviews.join(', ') : 'none'}`,
        '- Project memory sync policy: add missing seed files only; preserve existing user-owned files without overwrite.',
        `- ${projectMemoryMaintenanceSummaryLine}`,
        `- Project memory init/refresh prompt: ${projectMemoryRefreshHandoffPrompt}`,
        `- Project memory copied missing files: ${projectMemoryBootstrapReport.seed.copied_files.length > 0 ? projectMemoryBootstrapReport.seed.copied_files.join(', ') : 'none'}`,
        `- Project memory preserved files: ${projectMemoryBootstrapReport.seed.preserved_files.length}`,
        `- Project memory template update notices: ${projectMemoryBootstrapReport.seed.template_update_notices.length}`,
        '- Contract migration snippets auto-applied: 0',
        '- No files were moved or deleted; discovery sources were read-only.', '',
        '## Rule Source Mapping',
        '| Rule file | Source | Origin | Destination |',
        '|---|---|---|---|'
    ];

    if (optionalQualityChecksNotice) {
        lines.splice(
            lines.indexOf('- Contract migration snippets auto-applied: 0'),
            0,
            `- Optional quality checks notice: ${optionalQualityChecksNotice}`
        );
    }

    for (const item of ruleSourceMap) {
        lines.push(`| ${item.ruleFile} | ${tick}${item.source}${tick} | ${item.origin} | ${tick}${item.destination}${tick} |`);
    }

    lines.push('', '## Context Fill Policy');
    lines.push('- Project-context rules (`10/20/30/40/50/60`) prefer legacy `docs/agent-rules/*`, then existing `live` content, then template defaults.');
    lines.push('- All other rules prefer existing `live` content, then template defaults, then legacy docs fallback.');
    lines.push(`- Selected source-of-truth entrypoint (${tick}${trimmedSoT}${tick}) is provided by installer and points to ${tick}${resolveBundleName()}/live/docs/agent-rules/*${tick}.`);

    if (legacyStyleGuidanceActive) {
        lines.push('', '## Update Notices');
        lines.push('- **Style Guidance Update**: A new style contract is available, but was not applied because `docs/project-memory/` already has content and your `30-code-style.md` contains custom rules.');
        lines.push(`- The updated templates have been scaffolded as ${tick}${resolveBundleName()}/live/docs/agent-rules/30-code-style.template.md${tick} and ${tick}${resolveBundleName()}/live/docs/project-memory/conventions.template.md${tick}.`);
        lines.push('- Review them and manually update your code style or project memory to adopt the new contract. Delete the `.legacy-style-contract` marker when done.');
    }

    if (projectMemoryBootstrapReport.seed.template_update_notices.length > 0) {
        lines.push('', '## Project Memory Update Notices');
        lines.push(`- Existing files under ${tick}${resolveBundleName()}/live/docs/project-memory${tick} are user-owned and were preserved.`);
        lines.push('- Template guidance changed for the files below; review manually if you want to adopt the new guidance.');
        for (const notice of projectMemoryBootstrapReport.seed.template_update_notices) {
            lines.push(`- ${tick}${notice.livePath}${tick} preserved; compare with template ${tick}${notice.templatePath}${tick}.`);
        }
    }

    return lines;
}

function buildUsageLines(opts: BuildUsageOptions): string[] {
    const {
        lang,
        brevity,
        canonicalEntrypoint,
        enforceNoAutoCommit,
        fullSuiteValidationEnabled
    } = opts;
    const cliCommand = getNodeBundleCliCommand();
    const commitGuardLine = enforceNoAutoCommit
        ? `Hard no-auto-commit guard is enabled. It blocks detected agent-session commits while normal human commits remain available; for intentional manual commits from the same agent shell use: \`${getNodeHumanCommitCommand()}\`.`
        : 'Hard no-auto-commit guard is disabled.';
    const fullSuiteLine = fullSuiteValidationEnabled
        ? '- Mandatory full-suite validation is enabled through `garda-agent-orchestrator/live/config/workflow-config.json`; `next-step` routes `full-suite-validation` with the configured command when required.'
        : `- ${buildFullSuiteDisabledGuidance(cliCommand)}`;

    return [
        '# Usage Instructions', '',
        'Path: `garda-agent-orchestrator/live/USAGE.md`', '',
        `Language: ${lang}`,
        `Default response brevity: ${brevity}`, '',
        USAGE_CONTRACT_MARKERS.executeTasks,
        '## Execute Tasks',
        'Start by selecting a row from root `TASK.md` and tell the agent:',
        `- ${buildTaskStartNavigatorPrompt()}`,
        `- ${buildNextStepNavigatorGuidance(cliCommand)}`,
        `- ${buildSetupStartBannerSentence()}`,
        '- `next-step` owns the executable gate order. Static gate lists are policy context, not commands to guess by hand.',
        '- When independent review is required, launch a fresh sub-agent using your provider/internal tools and record the review only through Garda review gates.', '',
        USAGE_CONTRACT_MARKERS.profilesAndConfig,
        '## Profiles And Config',
        '- Active profile selection comes from `garda-agent-orchestrator/live/config/profiles.json`; the root `TASK.md` `Profile` column may override it per task, while `default` inherits the workspace active profile.',
        '- Inspect profiles with `node garda-agent-orchestrator/bin/garda.js profile current --target-root "."` or `profile list`; switch with `profile use <name>`; create a user profile with `profile create <name> ...`.',
        '- Review execution modes live in `garda-agent-orchestrator/live/config/workflow-config.json`; inspect with `node garda-agent-orchestrator/bin/garda.js workflow show --target-root "."` and explain with `workflow explain`.',
        '- Optional review capabilities live in `garda-agent-orchestrator/live/config/review-capabilities.json`; inspect or change them with `node garda-agent-orchestrator/bin/garda.js review-capabilities list|enable|disable ... --target-root "."`.',
        '- Optional custom review definitions live in `garda-agent-orchestrator/live/config/review-catalog.json`; inspect validated lanes and profile/dependency resolution with `node garda-agent-orchestrator/bin/garda.js review-catalog list|show|explain|validate ... --target-root "."`. Missing catalogs remain legacy-compatible.',
        '- Review-catalog mutations are guarded preview/confirm/apply operations, affect future task snapshots only, and must not be performed by loading or hand-editing the full catalog during ordinary task execution.',
        '- Scope budget, review-cycle guard, task-reset availability, and project-memory maintenance are workflow settings. Change them only through `node garda-agent-orchestrator/bin/garda.js workflow set ... --target-root "."`.',
        '- Ordinary document path exceptions live in `garda-agent-orchestrator/live/config/paths.json` as `ordinary_doc_paths`; they are auditable planning/changelog doc exceptions, not a global ignore list.', '',
        USAGE_CONTRACT_MARKERS.fullSuiteValidation,
        '## Full-Suite Validation',
        fullSuiteLine,
        '- Full-suite out-of-scope handling is configured in `workflow-config.json`; do not change it to bypass a failing gate.', '',
        USAGE_CONTRACT_MARKERS.indexingNote,
        '## Indexing Note',
        '- Where the host supports indexing controls, exclude `garda-agent-orchestrator/` from application-code, stack-detection, and IDE/AI semantic indexing. Keep explicit Garda rule/config/skill paths and `bin/garda.js` readable to agents.',
        '- Do not infer the project stack or commands from the orchestrator bundle; inspect the host repository outside `garda-agent-orchestrator/` for application evidence.', '',
        '## Scope Safety',
        '- If the workspace is already dirty before task-mode entry, do not continue as a normal run; isolate the task scope with `--use-staged` or repeated `--changed-file` values before preflight.',
        '- Keep generated runtime artifacts out of task scope unless the task explicitly owns them.', '',
        '## Update Workspace',
        `- Interactive update: \`${getNodeInteractiveUpdateCommand()}\``,
        `- Non-interactive apply: \`${getNodeNonInteractiveUpdateCommand()}\``,
        `- Project memory init/refresh prompt after setup/update: ${PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT}`, '',
        `Canonical instructions entrypoint for orchestration: \`${canonicalEntrypoint}\`.`,
        `Hard stop: first open \`${canonicalEntrypoint}\` and follow its routing links. Only then execute any task from \`TASK.md\`.`,
        'Orchestrator mode starts when task execution is requested from this file (`TASK.md`).',
        'If needed, the agent can add new tasks from user requests and then execute them in orchestrator mode.',
        commitGuardLine, '',
        'Tasks are managed in root `TASK.md`.',
        'This file can be replaced by the setup agent with project-specific instructions.'
    ];
}

export function runInitReportingStage(
    options: RunInitReportingStageOptions
): InitReportingStageResult {
    const sourceInventoryPath = path.join(options.liveRoot, 'source-inventory.md');
    const initReportPath = path.join(options.liveRoot, 'init-report.md');
    const projectDiscoveryPath = path.join(options.liveRoot, 'project-discovery.md');
    const usagePath = path.join(options.liveRoot, 'USAGE.md');
    const skillsIndexPath = path.join(options.liveRoot, 'config', 'skills-index.json');
    const gitignorePath = path.join(options.normalizedTarget, '.gitignore');
    const agentignorePath = path.join(options.normalizedTarget, '.agentignore');
    const sourceInventory = collectSourceInventory(options.targetRoot);
    const reviewCapabilitiesSync = options.dryRun
        ? null
        : syncReviewCapabilities(options.bundleRoot);
    const gitignoreEntries = buildGitignoreEntries(
        options.resolvedActiveEntryFiles,
        options.providerOrchestratorProfiles,
        options.claudeOrchestratorFullAccess,
        pathExists(path.join(options.normalizedTarget, '.qwen', 'settings.json')),
        options.providerMinimalism
    );
    let gitignoreEntriesAdded = 0;
    let agentignoreUpdated = false;

    bindContainedDestination(options.normalizedTarget, gitignorePath);
    const existingGitignoreContent = pathExists(gitignorePath)
        ? readTextFile(gitignorePath)
        : '';
    const gitignoreSync = syncManagedGitignoreBlockInContent(
        existingGitignoreContent,
        gitignoreEntries,
        options.claudeOrchestratorFullAccess
    );
    gitignoreEntriesAdded = gitignoreSync.addedEntries;
    if (!options.dryRun && gitignoreSync.changed) {
        writeContainedFile(options.normalizedTarget, gitignorePath, gitignoreSync.content);
    }

    bindContainedDestination(options.normalizedTarget, agentignorePath);
    const existingAgentignoreContent = pathExists(agentignorePath)
        ? readTextFile(agentignorePath)
        : '';
    const agentignoreSync = syncManagedAgentignoreActiveBlockInContent(
        existingAgentignoreContent,
        path.basename(options.bundleRoot)
    );
    agentignoreUpdated = agentignoreSync.changed;
    if (!options.dryRun && agentignoreSync.changed) {
        writeContainedFile(options.normalizedTarget, agentignorePath, agentignoreSync.content);
    }

    if (!options.dryRun) {
        const inventoryLines = buildSourceInventoryLines(
            sourceInventory,
            options.timestampIso
        );
        writeContainedFile(options.normalizedTarget, sourceInventoryPath, inventoryLines.join('\r\n'));

        const initReportLines = buildInitReportLines({
            timestampIso: options.timestampIso,
            projectName: options.projectName,
            targetRoot: options.targetRoot,
            ruleSourceMap: options.ruleSourceMap,
            ruleFiles: RULE_FILES,
            copiedSupportDirs: options.copiedSupportDirs,
            configMergeStatuses: options.configMergeStatuses,
            lang: options.lang,
            brevity: options.brevity,
            trimmedSoT: options.trimmedSoT,
            enforceNoAutoCommit: options.enforceNoAutoCommit,
            tokenEconomyEnabled: options.tokenEconomyEnabled,
            discovery: options.discovery,
            sourceInventory,
            reviewCapabilitiesSync,
            projectMemoryBootstrapReport: options.projectMemoryBootstrapReport,
            projectMemoryMaintenanceSummaryLine: options.projectMemoryMaintenanceSummaryLine,
            projectMemoryRefreshHandoffPrompt: PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT,
            optionalQualityChecksNotice: options.optionalQualityChecksNotice,
            legacyStyleGuidanceActive: options.legacyStyleGuidanceActive
        });
        initReportLines.push(...buildMigrationReportLines(options.migrationResult));
        writeContainedFile(options.normalizedTarget, initReportPath, initReportLines.join('\r\n'));

        const discoveryLines = buildProjectDiscoveryLines(
            options.discovery,
            options.timestampIso
        );
        writeContainedFile(options.normalizedTarget, projectDiscoveryPath, discoveryLines.join('\r\n'));

        if (!pathExists(usagePath)) {
            const usageLines = buildUsageLines({
                lang: options.lang,
                brevity: options.brevity,
                canonicalEntrypoint: options.canonicalEntrypoint,
                enforceNoAutoCommit: options.enforceNoAutoCommit,
                fullSuiteValidationEnabled: (
                    getFullSuiteEnabledDiagnostic(options.materializedWorkflowConfig) === 'true'
                )
            });
            writeContainedFile(options.normalizedTarget, usagePath, usageLines.join('\r\n'));
        }

        writeSkillsIndex(options.bundleRoot);
        writeProtectedControlPlaneManifest(options.normalizedTarget);
    }

    return {
        sourceInventory,
        reviewCapabilitiesSync,
        gitignoreEntriesAdded,
        agentignoreUpdated,
        skillsIndexPath,
        sourceInventoryPath,
        initReportPath,
        projectDiscoveryPath,
        usagePath
    };
}
