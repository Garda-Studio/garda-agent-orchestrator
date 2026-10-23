import * as path from 'node:path';
import { pathExists } from './filesystem';
import { readJsonFile } from './json';
import {
    buildDefaultWorkflowConfig,
    getWorkflowConfigPath,
    type ProjectMemoryMaintenanceConfig
} from './workflow-config';
import { isPlainObject } from './config-merge';
import {
    PROJECT_MEMORY_MAP_READ_GUIDANCE,
    PROJECT_MEMORY_MAP_WRITE_CONTRACT
} from './project-memory';

export const PROJECT_MEMORY_INIT_REFRESH_PROMPT = [
    'Initialize or refresh Garda project memory.',
    'Inspect the repository, starting with `garda-agent-orchestrator/live/docs/project-memory/README.md` and `garda-agent-orchestrator/live/docs/project-memory/compact.md`.',
    'During agent-init onboarding, edit these files directly: do not add a TASK.md task or enter task mode for initialization, because agent-init refreshes the protected baseline itself. Inside an active task, keep these edits within that task.',
    PROJECT_MEMORY_MAP_READ_GUIDANCE,
    'Update only `garda-agent-orchestrator/live/docs/project-memory/*.md` files that are missing, stale, template-seeded, placeholder-only, incomplete, or no longer shaped as a compact project map.',
    PROJECT_MEMORY_MAP_WRITE_CONTRACT,
    'Keep `compact.md` concise and link-oriented; record confirmed stack, commands, module map, decisions, risks, and unknown/custom stack fallback from source, configs, tests, durable docs, or explicit user answers.',
    'Do not edit generated `garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md`, do not invent facts, and do not overwrite user-authored memory without preserving its facts.',
    'Record project-memory update evidence when the workflow asks for it.'
].join(' ');

export const PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT = PROJECT_MEMORY_INIT_REFRESH_PROMPT;

export interface ProjectMemoryMaintenanceRolloutSummary {
    enabled: boolean;
    mode: string;
    summary_line: string;
    refresh_handoff_prompt: string;
}

function cloneDefaultProjectMemoryMaintenance(): ProjectMemoryMaintenanceConfig {
    return buildDefaultWorkflowConfig().project_memory_maintenance;
}

export function normalizeProjectMemoryMaintenanceForDisplay(input: unknown): ProjectMemoryMaintenanceConfig {
    const defaults = cloneDefaultProjectMemoryMaintenance();
    if (!isPlainObject(input)) {
        return defaults;
    }

    return {
        ...defaults,
        ...input
    } as ProjectMemoryMaintenanceConfig;
}

export function buildProjectMemoryMaintenanceSummaryLine(config: ProjectMemoryMaintenanceConfig): string {
    return `Project memory maintenance: ${config.enabled ? config.mode : 'disabled'} read_strategy=${config.read_strategy} max_compact_summary_chars=${config.max_compact_summary_chars} require_user_approval_for_writes=${config.require_user_approval_for_writes}`;
}

export function buildProjectMemoryMaintenanceRolloutSummary(
    config: ProjectMemoryMaintenanceConfig
): ProjectMemoryMaintenanceRolloutSummary {
    return {
        enabled: config.enabled,
        mode: config.enabled ? config.mode : 'off',
        summary_line: buildProjectMemoryMaintenanceSummaryLine(config),
        refresh_handoff_prompt: PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT
    };
}

export function readProjectMemoryMaintenanceFromBundle(bundleRoot: string): ProjectMemoryMaintenanceConfig {
    const defaults = cloneDefaultProjectMemoryMaintenance();
    const workflowConfigPath = getWorkflowConfigPath(bundleRoot);
    if (!pathExists(workflowConfigPath)) {
        return defaults;
    }

    try {
        const parsed = readJsonFile(workflowConfigPath);
        if (!isPlainObject(parsed)) {
            return defaults;
        }
        return normalizeProjectMemoryMaintenanceForDisplay(parsed.project_memory_maintenance);
    } catch {
        return defaults;
    }
}

export function readProjectMemoryMaintenanceRolloutSummaryFromBundle(
    bundleRoot: string
): ProjectMemoryMaintenanceRolloutSummary {
    return buildProjectMemoryMaintenanceRolloutSummary(readProjectMemoryMaintenanceFromBundle(path.resolve(bundleRoot)));
}
