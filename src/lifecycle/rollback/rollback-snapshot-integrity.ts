import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeContainedFile } from '../../core/contained-filesystem';
import { createHash } from 'node:crypto';
import { resolveBundleName } from '../../core/constants';
import { ensureRelativeSafe, ensureWithinRoot } from '../generic-utils';
import type { RollbackRecord } from '../lifecycle-common';

const INTEGRITY_FILE = 'rollback-integrity.json';
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function getRollbackSnapshotIntegrityPath(snapshotRoot: string): string {
    return path.join(snapshotRoot, INTEGRITY_FILE);
}

interface EntryDigest {
    relativePath: string;
    kind: 'file' | 'directory' | 'missing';
    sha256: string | null;
}

interface SnapshotIntegrity {
    schemaVersion: 1;
    snapshotName: string;
    recordsSha256: string;
    version: string | null;
    entries: EntryDigest[];
}

function hash(bytes: string | Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

export function assertNoLinkedPathComponents(root: string, candidate: string): void {
    const resolvedRoot = path.resolve(root);
    const resolved = ensureWithinRoot(resolvedRoot, candidate, 'Rollback snapshot entry');
    const relative = path.relative(resolvedRoot, resolved);
    const components = relative ? relative.split(path.sep) : [];
    let current = resolvedRoot;
    for (const component of ['', ...components]) {
        if (component) current = path.join(current, component);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) {
                throw new Error(`Rollback snapshot entry traverses symlink or junction: ${current}`);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
            throw error;
        }
    }
}

function digestPath(entryPath: string): { kind: EntryDigest['kind']; sha256: string | null } {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(entryPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', sha256: null };
        throw error;
    }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(`Rollback snapshot contains an unsupported entry: ${entryPath}`);
    }
    if (stat.isFile()) return { kind: 'file', sha256: hash(fs.readFileSync(entryPath)) };
    const children = fs.readdirSync(entryPath).sort().map((name) => {
        const child = digestPath(path.join(entryPath, name));
        return [name, child.kind, child.sha256];
    });
    return { kind: 'directory', sha256: hash(JSON.stringify(children)) };
}

function getVersion(snapshotRoot: string, records: readonly RollbackRecord[]): string | null {
    const versionRelativePath = `${resolveBundleName()}/VERSION`;
    const versionRecord = records.find((record) => record.relativePath.replace(/\\/g, '/') === versionRelativePath);
    if (!versionRecord?.existed || versionRecord.pathType !== 'file') return null;
    const versionPath = path.join(snapshotRoot, versionRelativePath);
    const version = fs.readFileSync(versionPath, 'utf8').trim();
    if (!version) throw new Error(`Rollback snapshot VERSION is empty: ${versionPath}`);
    return version;
}

function buildIntegrity(snapshotRoot: string, records: readonly RollbackRecord[], recordsBytes: Buffer): SnapshotIntegrity {
    const entries = records.map((record) => {
        ensureRelativeSafe(record.relativePath, 'Rollback record relativePath');
        const entryPath = path.join(snapshotRoot, record.relativePath);
        assertNoLinkedPathComponents(snapshotRoot, entryPath);
        const digest = digestPath(entryPath);
        if (record.existed && digest.kind !== record.pathType) {
            throw new Error(`Rollback snapshot entry type mismatch: ${record.relativePath}`);
        }
        if (!record.existed && digest.kind !== 'missing') {
            throw new Error(`Rollback snapshot has an unexpected entry: ${record.relativePath}`);
        }
        return { relativePath: record.relativePath, ...digest };
    });
    return {
        schemaVersion: 1,
        snapshotName: path.basename(path.resolve(snapshotRoot)),
        recordsSha256: hash(recordsBytes),
        version: getVersion(snapshotRoot, records),
        entries
    };
}

export function writeRollbackSnapshotIntegrity(snapshotRoot: string, records: readonly RollbackRecord[], recordsBytes: Buffer): void {
    const integrity = buildIntegrity(snapshotRoot, records, recordsBytes);
    const integrityPath = getRollbackSnapshotIntegrityPath(snapshotRoot);
    assertNoLinkedPathComponents(snapshotRoot, integrityPath);
    writeContainedFile(path.parse(path.resolve(snapshotRoot)).root,
        integrityPath, JSON.stringify(integrity, null, 2));
}

export function verifyRollbackSnapshotIntegrity(snapshotRoot: string, records: readonly RollbackRecord[], recordsBytes: Buffer): SnapshotIntegrity {
    const integrityPath = getRollbackSnapshotIntegrityPath(snapshotRoot);
    assertNoLinkedPathComponents(snapshotRoot, integrityPath);
    if (!fs.existsSync(integrityPath) || fs.lstatSync(integrityPath).isSymbolicLink()) {
        throw new Error(`Rollback snapshot integrity metadata is missing or unsafe: ${integrityPath}`);
    }
    let stored: SnapshotIntegrity;
    try {
        stored = JSON.parse(fs.readFileSync(integrityPath, 'utf8')) as SnapshotIntegrity;
    } catch {
        throw new Error(`Rollback snapshot integrity metadata is invalid: ${integrityPath}`);
    }
    if (stored?.schemaVersion !== 1 || stored.snapshotName !== path.basename(path.resolve(snapshotRoot))
        || !HASH_PATTERN.test(stored.recordsSha256) || stored.recordsSha256 !== hash(recordsBytes)
        || (stored.version !== null && (typeof stored.version !== 'string' || !stored.version.trim()))
        || !Array.isArray(stored.entries) || stored.entries.length !== records.length) {
        throw new Error(`Rollback snapshot integrity mismatch: ${integrityPath}`);
    }
    const actual = buildIntegrity(snapshotRoot, records, recordsBytes);
    if (JSON.stringify(actual) !== JSON.stringify(stored)) {
        throw new Error(`Rollback snapshot integrity mismatch: ${integrityPath}`);
    }
    return actual;
}

export function verifyRestoredRollbackSnapshot(targetRoot: string, snapshotRoot: string, records: readonly RollbackRecord[]): void {
    const recordsBytes = fs.readFileSync(path.join(snapshotRoot, 'rollback-records.json'));
    const integrity = verifyRollbackSnapshotIntegrity(snapshotRoot, records, recordsBytes);
    for (const entry of integrity.entries) {
        ensureRelativeSafe(entry.relativePath, 'Rollback restored relativePath');
        const restoredPath = path.join(targetRoot, entry.relativePath);
        assertNoLinkedPathComponents(targetRoot, restoredPath);
        const actual = digestPath(restoredPath);
        if (actual.kind !== entry.kind || actual.sha256 !== entry.sha256) {
            throw new Error(`Rollback restored entry differs from selected snapshot: ${entry.relativePath}`);
        }
    }
    if (integrity.version !== null) {
        const version = fs.readFileSync(path.join(targetRoot, resolveBundleName(), 'VERSION'), 'utf8').trim();
        if (version !== integrity.version) throw new Error('Rollback restored VERSION differs from selected snapshot.');
    }
}
