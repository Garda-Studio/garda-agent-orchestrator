import * as path from 'node:path';
import { resolveBundleName } from '../../core/constants';
import { ensureRelativeSafe, ensureWithinRoot } from '../generic-utils';
import type { RollbackRecord } from '../lifecycle-common';
import { getUninstallRollbackItems } from '../uninstall/uninstall-helpers';
import { getUpdateRollbackItems } from '../update/update';

function canonicalDestination(relativePath: string): string {
    // Producers persist POSIX-relative units on every platform. Do not turn a
    // literal POSIX backslash filename or an alias into another allowed unit.
    if (!relativePath || relativePath === '.' || relativePath.includes('\\')
        || relativePath.includes('\0') || path.posix.isAbsolute(relativePath)
        || path.posix.normalize(relativePath) !== relativePath
        || relativePath.split('/').includes('..')) {
        throw new Error(`Noncanonical snapshot rollback destination: ${relativePath}`);
    }
    ensureRelativeSafe(relativePath, 'Snapshot rollback destination');
    return relativePath;
}

/** Destination permission comes from trusted producers and the operator input,
 * never from snapshot records, their reported version or recomputable hashes.
 * This constrains recovery units; it does not authenticate their payload origin.
 */
export function assertSupportedSnapshotRollbackDestinations(
    targetRoot: string, records: readonly RollbackRecord[], initAnswersPath?: string
): void {
    const defaultAnswers = path.join(targetRoot, resolveBundleName(), 'runtime', 'init-answers.json');
    const selectedAnswers = ensureWithinRoot(
        targetRoot,
        initAnswersPath === undefined ? defaultAnswers : path.resolve(targetRoot, initAnswersPath),
        'Snapshot rollback init answers destination'
    );
    const answersRelative = path.relative(targetRoot, selectedAnswers).split(path.sep).join('/');
    canonicalDestination(answersRelative);

    const supported = new Set([
        ...getUpdateRollbackItems(targetRoot, defaultAnswers),
        ...getUpdateRollbackItems(targetRoot, selectedAnswers),
        ...getUninstallRollbackItems()
    ]);
    for (const record of records) {
        const destination = canonicalDestination(record.relativePath);
        if (!supported.has(destination)) {
            throw new Error(`Unsupported snapshot rollback destination: ${record.relativePath}`);
        }
    }
}
