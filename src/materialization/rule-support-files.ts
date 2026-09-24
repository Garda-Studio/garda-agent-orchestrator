import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeContainedFile } from '../core/contained-filesystem';

export const OPTIONAL_RULE_SUPPORT_FILES = Object.freeze([
    '40-command-reference.md'
]);

export interface SyncOptionalRuleSupportFilesOptions {
    bundleRoot: string;
    dryRun?: boolean;
}

/**
 * Synchronizes rule appendices that are required by the current rule contract
 * but are intentionally excluded from the mandatory task-entry rule pack.
 *
 * This helper lives in its own module so an update launched by a legacy runtime
 * can load the current implementation after the new bundle has been synced,
 * without reusing a stale cached materialization module.
 */
export function syncOptionalRuleSupportFiles(
    options: SyncOptionalRuleSupportFilesOptions
): void {
    const templateRuleRoot = path.join(options.bundleRoot, 'template', 'docs', 'agent-rules');
    const liveRuleRoot = path.join(options.bundleRoot, 'live', 'docs', 'agent-rules');

    for (const supportFile of OPTIONAL_RULE_SUPPORT_FILES) {
        const templatePath = path.join(templateRuleRoot, supportFile);
        if (!fs.existsSync(templatePath)) {
            throw new Error(`No source found for optional rule support file: ${supportFile}`);
        }

        const content = fs.readFileSync(templatePath, 'utf8');
        if (!content.trim()) {
            throw new Error(`Optional rule support source is empty: ${templatePath}`);
        }

        if (!options.dryRun) {
            writeContainedFile(options.bundleRoot, path.join(liveRuleRoot, supportFile), content);
        }
    }
}
