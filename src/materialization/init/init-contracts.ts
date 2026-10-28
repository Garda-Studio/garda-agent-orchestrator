import type { syncReviewCapabilities } from '../../runtime/skills';
import type { ProjectDiscovery } from '../project-discovery';

export interface RunInitOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    assistantLanguage?: string;
    assistantBrevity?: string;
    sourceOfTruth?: string;
    enforceNoAutoCommit?: boolean;
    claudeOrchestratorFullAccess?: boolean;
    tokenEconomyEnabled?: boolean;
    providerMinimalism?: boolean;
    activeAgentFilesSeed?: string | null;
    preserveLegacyReviewExecutionPolicyOmission?: boolean;
    preservedCompileGateCommand?: string | null;
    lifecycleLockAlreadyHeld?: boolean;
}

export interface RuleSourceMapEntry {
    ruleFile: string;
    source: string;
    origin: string;
    destination: string;
    backupPath?: string;
    warning?: string;
}

export interface SourceInventoryEntry {
    path: string;
    exists: boolean;
}

export interface SourceInventory {
    projectRoot: string;
    legacyEntrypoints: SourceInventoryEntry[];
    legacyRuleRoot: string;
    legacyRuleFiles: string[];
    docsMarkdownFiles: string[];
}

export type ReviewCapabilitiesSyncResult = ReturnType<typeof syncReviewCapabilities>;
export type InitProjectDiscovery = ProjectDiscovery;
