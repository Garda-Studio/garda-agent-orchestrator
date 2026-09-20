import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../constants';
import { assertWorkflowTransactionReadable } from '../workflow-transaction-state';
import { validateCompactSettings, type CompactSettings } from './contract';
import { compactSettingsFromConfig } from './setting-definitions';

export function readCompactSettings(repoRoot: string): CompactSettings {
    const file = path.join(repoRoot, resolveBundleName(), 'live/config/workflow-config.json');
    assertWorkflowTransactionReadable(path.join(repoRoot, resolveBundleName()));
    if (!fs.existsSync(file)) return validateCompactSettings({});
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return compactSettingsFromConfig(config.compact ?? {});
}
