import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { CompactStore, openCompactFile } from './store-paths';
import { COMPACT_METADATA_BYTES, compactPreview, type CompactSettings } from './contract';

export type CompactStream = 'stdout' | 'stderr';
export interface CompactOutcome { exitCode: number; timedOut: boolean; cancelled: boolean; sinkError?: string }
export interface CompactManifest extends CompactOutcome {
    version: 1; taskId: string; ref: string; createdAt: string; complete: boolean;
    streams: Record<CompactStream, { bytes: number; sha256: string }>;
}
export interface CompactResult extends CompactOutcome { stdout: string; stderr: string; ref?: string; complete: boolean }

const MEMORY_BYTES = 12000;

export class CompactCapture {
    private readonly buffers: Record<CompactStream, Buffer> = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    private readonly hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') };
    private readonly counts = { stdout: 0, stderr: 0 };
    private readonly files: Partial<Record<CompactStream, number>> = {};
    private readonly samples: Record<CompactStream, Buffer> = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    private ref?: string;
    private failure?: string;
    private finished = false;

    constructor(private readonly store: CompactStore, private readonly taskId: string, private readonly settings: CompactSettings) {}

    private spill(): void {
        const total = this.store.usage();
        const task = this.store.usage(this.taskId);
        if (total.bytes + this.settings.runBytes > this.settings.workspaceBytes || task.bytes + this.settings.runBytes > this.settings.taskBytes || total.runs >= this.settings.maxRuns) {
            throw new Error('Compact cache quota exhausted; current-task output was preserved.');
        }
        this.ref = randomBytes(16).toString('hex');
        const dir = this.store.runPath(this.taskId, this.ref, true);
        for (const stream of ['stdout', 'stderr'] as const) {
            this.files[stream] = openCompactFile(path.join(dir, `${stream}.log`), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
            this.writeFile(stream, this.buffers[stream]);
            this.buffers[stream] = Buffer.alloc(0);
        }
    }

    private writeFile(stream: CompactStream, bytes: Buffer): void {
        const fd = this.files[stream];
        if (fd === undefined) throw new Error('Compact stream is not open.');
        let offset = 0;
        while (offset < bytes.length) {
            const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
            if (!written) throw new Error('Compact write made no progress.');
            offset += written;
        }
    }

    async write(stream: CompactStream, chunk: Buffer): Promise<void> {
        if (this.finished || this.failure) throw new Error(this.failure || 'Compact capture is closed.');
        try {
            const available = this.settings.runBytes - COMPACT_METADATA_BYTES - this.counts.stdout - this.counts.stderr;
            const bytes = chunk.subarray(0, Math.max(0, available));
            if (!this.ref && (this.counts.stdout + this.counts.stderr + chunk.length > MEMORY_BYTES || chunk.length > available)) this.spill();
            if (this.ref) this.writeFile(stream, bytes);
            else this.buffers[stream] = Buffer.concat([this.buffers[stream], bytes]);
            this.counts[stream] += bytes.length;
            this.hashes[stream].update(bytes);
            const previous = this.samples[stream];
            this.samples[stream] = previous.length + bytes.length <= MEMORY_BYTES
                ? Buffer.concat([previous, bytes])
                : Buffer.concat([
                    Buffer.concat([previous, bytes.subarray(0, MEMORY_BYTES / 2)]).subarray(0, MEMORY_BYTES / 2),
                    Buffer.concat([previous.subarray(-MEMORY_BYTES / 2), bytes.subarray(-MEMORY_BYTES / 2)]).subarray(-MEMORY_BYTES / 2)
                ]);
            if (bytes.length !== chunk.length) throw new Error('Compact capture limit reached; narrow the inspection.');
        } catch (error) {
            this.failure = error instanceof Error ? error.message : String(error);
            throw error;
        }
    }

    finish(outcome: CompactOutcome): CompactResult {
        if (this.finished) throw new Error('Compact capture is already finalized.');
        try {
            if (!this.ref && !this.failure && (compactPreview(this.buffers.stdout.toString('utf8'), this.settings).omitted || compactPreview(this.buffers.stderr.toString('utf8'), this.settings).omitted)) this.spill();
        } catch (error) { this.failure = error instanceof Error ? error.message : String(error); }
        this.finished = true;
        for (const fd of Object.values(this.files)) fs.closeSync(fd);
        const complete = !this.failure && !outcome.sinkError && !outcome.timedOut && !outcome.cancelled;
        if (this.ref) {
            const manifest: CompactManifest = {
                version: 1, taskId: this.taskId, ref: this.ref, createdAt: new Date().toISOString(), ...outcome,
                ...(this.failure ? { sinkError: this.failure } : {}), complete,
                streams: {
                    stdout: { bytes: this.counts.stdout, sha256: this.hashes.stdout.digest('hex') },
                    stderr: { bytes: this.counts.stderr, sha256: this.hashes.stderr.digest('hex') }
                }
            };
            const dir = this.store.runPath(this.taskId, this.ref);
            try {
                const fd = openCompactFile(path.join(dir, 'manifest.tmp'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
                try { fs.writeFileSync(fd, JSON.stringify(manifest)); } finally { fs.closeSync(fd); }
                fs.renameSync(path.join(dir, 'manifest.tmp'), path.join(dir, 'manifest.json'));
            } catch (error) {
                this.failure = `Capture publication failed: ${error instanceof Error ? error.message : String(error)}`;
                this.ref = undefined;
            }
        }
        return { ...outcome, ...(this.failure ? { sinkError: this.failure } : {}), complete: complete && !this.failure,
            stdout: this.samples.stdout.toString('utf8'), stderr: this.samples.stderr.toString('utf8'), ...(this.ref ? { ref: this.ref } : {}) };
    }
}
