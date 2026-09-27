import * as path from 'node:path';
import { quoteCommandValue } from '../../core/command-quoting';
import { type UpdateAvailabilityView } from './update-availability-types';

export function buildUpdateCommand(repoRoot: string): string {
    return `garda check-update --target-root ${quoteCommandValue(path.resolve(repoRoot).replace(/\\/gu, '/'))} --apply`;
}

export function formatUpdateAvailabilityNotice(repoRoot: string, view: UpdateAvailabilityView): string {
    if (view.status !== 'available' || !view.currentVersion || !view.latestVersion) return '';
    return `Garda update available: ${view.currentVersion} → ${view.latestVersion}\n${buildUpdateCommand(repoRoot)}`;
}
