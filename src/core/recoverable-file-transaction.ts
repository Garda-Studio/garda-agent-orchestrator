import * as fs from 'node:fs';
import * as path from 'node:path';
import { fsyncDirectoryBestEffort, writeFileAtomically } from './filesystem';
import { acquireFilesystemLock, inspectFilesystemLock, releaseFilesystemLock } from '../gate-runtime/task-events-locking';
import {
    assertTransactionPath, hashTransactionBytes, readTransactionBytes, readFileTransactionJournal,
    MAX_TRANSACTION_FILE_BYTES, MAX_TRANSACTION_JOURNAL_BYTES,
    type FileTransactionJournal, type FileTransactionEntry
} from './file-transaction-journal';

export interface FileTransactionOptions {
    root: string;
    journalPath: string;
    lockPath: string;
    files: Readonly<Record<string, string>>;
}

const ownedTransactions = new Set<string>();

export function isFileTransactionOwned(journalPath: string): boolean {
    return ownedTransactions.has(path.resolve(journalPath));
}

export class RecoverableFileTransaction {
    private journal: FileTransactionJournal;
    private readonly initialHashes = new Map<string, string | null>();

    constructor(private readonly options: FileTransactionOptions, private readonly assertOwned: () => void) {
        this.journal = { schema_version: 1, root: options.root, phase: 'prepared', entries: [] };
    }

    begin(): void {
        this.assertOwned();
        for (const [id, file] of Object.entries(this.options.files)) {
            this.initialHashes.set(id, hashTransactionBytes(readTransactionBytes(this.options.root, file)));
        }
    }

    private persist(): void {
        this.assertOwned();
        const content = JSON.stringify(this.journal) + '\n';
        if (Buffer.byteLength(content) > MAX_TRANSACTION_JOURNAL_BYTES) throw new Error('Transaction journal exceeds its byte budget.');
        assertTransactionPath(this.options.root, this.options.journalPath);
        writeFileAtomically(this.options.journalPath, content);
    }

    private resolveId(filePath: string): string {
        const id = Object.keys(this.options.files).find((key) => this.options.files[key] === path.resolve(filePath));
        if (!id) throw new Error('Write is outside the transaction allowlist.');
        return id;
    }

    write(filePath: string, content: string | Buffer): void {
        this.assertOwned();
        const id = this.resolveId(filePath);
        const target = this.options.files[id];
        const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        if (bytes.length > MAX_TRANSACTION_FILE_BYTES) throw new Error('Transaction file exceeds its byte budget.');
        const current = readTransactionBytes(this.options.root, target);
        let entry = this.journal.entries.find((candidate) => candidate.id === id);
        const expected = entry ? entry.published_sha256.at(-1) : this.initialHashes.get(id);
        if (hashTransactionBytes(current) !== expected) {
            throw new Error('Transaction target changed outside the writer lock.');
        }
        if (!entry) {
            entry = {
                id, before: current?.toString('base64') ?? null, before_sha256: hashTransactionBytes(current),
                published_sha256: [], mode: current === null ? null : fs.lstatSync(target).mode & 0o777
            };
            this.journal.entries.push(entry);
        }
        if (entry.published_sha256.length >= 32) throw new Error('Too many writes to one transaction target.');
        entry.published_sha256.push(hashTransactionBytes(bytes)!);
        this.persist();
        assertTransactionPath(this.options.root, target);
        this.assertOwned();
        if (hashTransactionBytes(readTransactionBytes(this.options.root, target)) !== hashTransactionBytes(current)) {
            throw new Error('Transaction target changed during intent publication.');
        }
        writeFileAtomically(target, bytes);
    }

    append(filePath: string, text: string): void {
        this.resolveId(filePath);
        const current = readTransactionBytes(this.options.root, path.resolve(filePath));
        this.write(filePath, Buffer.concat([current ?? Buffer.alloc(0), Buffer.from(text, 'utf8')]));
    }

    recover(): void {
        this.assertOwned();
        const journal = readFileTransactionJournal(this.options.root, this.options.journalPath, Object.keys(this.options.files));
        if (!journal) return;
        // Validate every participant before restoring any, including already restored files.
        for (const entry of journal.entries) this.validateRecoveryTarget(entry, journal.phase);
        if (journal.phase === 'prepared') {
            for (const entry of [...journal.entries].reverse()) this.restore(entry);
        }
        fs.unlinkSync(this.options.journalPath);
        fsyncDirectoryBestEffort(path.dirname(this.options.journalPath));
    }

    private validateRecoveryTarget(entry: FileTransactionEntry, phase: FileTransactionJournal['phase']): void {
        const hash = hashTransactionBytes(readTransactionBytes(this.options.root, this.options.files[entry.id]));
        const matches = phase === 'committed'
            ? hash === entry.published_sha256.at(-1)
            : hash === entry.before_sha256 || (hash !== null && entry.published_sha256.includes(hash));
        if (!matches) throw new Error(`Transaction recovery conflict: ${entry.id}; preserve the journal for operator recovery.`);
    }

    private restore(entry: FileTransactionEntry): void {
        this.assertOwned();
        this.validateRecoveryTarget(entry, 'prepared');
        const target = this.options.files[entry.id];
        if (hashTransactionBytes(readTransactionBytes(this.options.root, target)) === entry.before_sha256) return;
        if (entry.before === null) {
            if (fs.existsSync(target)) fs.unlinkSync(target);
            fsyncDirectoryBestEffort(path.dirname(target));
        } else {
            writeFileAtomically(target, Buffer.from(entry.before, 'base64'));
            if (entry.mode !== null) fs.chmodSync(target, entry.mode);
        }
    }

    commit(): void {
        if (this.journal.entries.length === 0) return;
        for (const entry of this.journal.entries) this.validateRecoveryTarget(entry, 'committed');
        this.journal.phase = 'committed';
        this.persist();
        fs.unlinkSync(this.options.journalPath);
        fsyncDirectoryBestEffort(path.dirname(this.options.journalPath));
    }
}

function normalizeTransactionOptions(options: FileTransactionOptions): FileTransactionOptions {
    fs.mkdirSync(options.root, { recursive: true });
    const root = fs.realpathSync(options.root);
    const resolve = (value: string) => path.resolve(root, path.relative(path.resolve(options.root), path.resolve(value)));
    const normalized = {
        root, journalPath: resolve(options.journalPath), lockPath: resolve(options.lockPath),
        files: Object.fromEntries(Object.entries(options.files).map(([id, file]) => [id, resolve(file)]))
    };
    assertTransactionPath(root, normalized.journalPath);
    for (const file of Object.values(normalized.files)) assertTransactionPath(root, file);
    assertTransactionPath(root, path.join(path.dirname(normalized.lockPath), '.lock-boundary'));
    if (fs.existsSync(normalized.lockPath)) {
        const stat = fs.lstatSync(normalized.lockPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe workflow transaction lock.');
    }
    return normalized;
}

export function withRecoverableFileTransaction<T>(options: FileTransactionOptions, operation: (transaction: RecoverableFileTransaction) => T): T {
    const normalized = normalizeTransactionOptions(options);
    const { handle } = acquireFilesystemLock(normalized.lockPath, {
        ownerLabel: 'workflow-config-transaction', requireKnownDeadOwner: true, allowForeignHostStaleRecovery: false
    });
    const transaction = new RecoverableFileTransaction(normalized, () => {
        const inspection = inspectFilesystemLock(handle.lockPath);
        if (inspection.metadata.lock_id !== handle.lockId || inspection.metadata.pid !== process.pid) {
            throw new Error('Workflow transaction lock ownership changed.');
        }
    });
    ownedTransactions.add(path.resolve(options.journalPath));
    try {
        transaction.recover();
        transaction.begin();
        try {
            const result = operation(transaction);
            transaction.commit();
            return result;
        } catch (error) {
            try {
                transaction.recover();
            } catch (recoveryError) {
                throw new AggregateError([error, recoveryError], 'Workflow transaction failed; recovery pending.');
            }
            throw error;
        }
    } finally {
        ownedTransactions.delete(path.resolve(options.journalPath));
        releaseFilesystemLock(handle);
    }
}
