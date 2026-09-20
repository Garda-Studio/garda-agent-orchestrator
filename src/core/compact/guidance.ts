import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../constants';
import { readCompactSettings } from './settings';

export function compactCommandPrefix(repoRoot: string): string {
    const cli = fs.existsSync(path.join(repoRoot, 'bin/garda.js')) && fs.existsSync(path.join(repoRoot, 'src'))
        ? 'bin/garda.js' : `${resolveBundleName()}/bin/garda.js`;
    return `node ${cli} compact`;
}

export function compactGuidance(repoRoot: string, taskId: string, reviewer = false): string {
    try {
        const settings = readCompactSettings(repoRoot);
        if (!settings.enabled) return '';
        const families = (['git', 'file', 'rg'] as const).filter(key => settings[key]);
        if (!families.length) return '';
        const prefix = compactCommandPrefix(repoRoot);
        const hint = `Compact: prefer ${prefix} <${families.join('|')}> --task-id ${taskId}; --help for syntax; read/search retained output only as needed.`;
        return reviewer ? hint + ' Use only sources authorized by this handoff and captures you produced or were explicitly given. The compact CLI may write its own ephemeral cache and lock; source/control artifacts stay read-only. Read required rules, handoff and integrity-bound evidence in full via their prescribed paths. A preview is not review coverage; inspect omitted relevant ranges. Do not run next-step.' : hint;
    } catch { return ''; }
}
