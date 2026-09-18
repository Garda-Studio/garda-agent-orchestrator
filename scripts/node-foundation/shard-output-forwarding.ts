type Sink = NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean; writableNeedDrain?: boolean };
type SinkObserver = (error?: Error) => void;

interface SinkState {
    blocked: boolean;
    pendingWrites: number;
    error?: Error;
    observers: Set<SinkObserver>;
    release: () => void;
}

const sinkStates = new WeakMap<Sink, SinkState>();

function observeSink(sink: Sink, observer: SinkObserver): SinkState {
    let state = sinkStates.get(sink);
    if (!state) {
        const observers = new Set<SinkObserver>();
        let releaseScheduled = false;
        const notify = (error?: Error): void => {
            if (error) state!.error = error;
            for (const callback of Array.from(observers)) callback(error);
        };
        const drain = (): void => { state!.blocked = false; notify(); };
        const error = (cause: Error): void => notify(cause);
        const close = (): void => notify(new Error('Shard output sink closed before release.'));
        state = {
            blocked: Boolean(sink.writableNeedDrain),
            pendingWrites: 0,
            observers,
            release: () => {
                if (releaseScheduled) return;
                releaseScheduled = true;
                // Write callbacks run before the corresponding error event.
                setImmediate(() => {
                    releaseScheduled = false;
                    if (observers.size > 0 || state!.pendingWrites > 0) return;
                    sink.removeListener('drain', drain);
                    sink.removeListener('error', error);
                    sink.removeListener('close', close);
                    sink.removeListener('finish', close);
                    if (sinkStates.get(sink) === state) sinkStates.delete(sink);
                });
            }
        };
        sinkStates.set(sink, state);
        sink.on('drain', drain);
        sink.on('error', error);
        sink.on('close', close);
        sink.on('finish', close);
    }
    state.observers.add(observer);
    if (sink.destroyed || sink.writableEnded) state.error ??= new Error('Shard output sink is unavailable.');
    return state;
}

export class ShardOutputForwarder {
    private readonly sinks = new Map<Sink, SinkState>();
    private readonly sources = new Map<NodeJS.ReadableStream, () => void>();
    private readonly waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    private pendingWrites = 0;
    private cancelled = false;
    private failure?: Error;
    private readonly observer = (error?: Error): void => {
        if (error) this.fail(error);
        else this.updateFlow();
    };

    constructor(
        private readonly log: Sink,
        stdout: Sink,
        stderr: Sink,
        private readonly onError: (error: Error) => void
    ) {
        for (const sink of new Set([log, stdout, stderr])) {
            this.sinks.set(sink, observeSink(sink, this.observer));
        }
        const unavailable = Array.from(this.sinks.values()).find((state) => state.error)?.error;
        if (unavailable) queueMicrotask(() => this.fail(unavailable));
    }

    forward(source: NodeJS.ReadableStream | null | undefined, consoleSink: Sink, onData: () => void): void {
        if (!source) return;
        if (this.cancelled) { source.pause(); return; }
        const data = (chunk: Buffer | string): void => {
            if (this.cancelled) return;
            onData();
            this.write(this.log, chunk);
            if (!this.cancelled) this.write(consoleSink, chunk);
            this.updateFlow();
        };
        const end = (): void => { detach(); this.sources.delete(source); this.checkFlushed(); };
        const error = (cause: Error): void => this.fail(cause);
        const close = (): void => {
            if (this.sources.has(source)) this.fail(new Error('Shard output source closed before end.'));
        };
        const detach = (): void => {
            source.removeListener('data', data);
            source.removeListener('end', end);
            source.removeListener('error', error);
            source.removeListener('close', close);
        };
        this.sources.set(source, detach);
        source.on('end', end);
        source.on('error', error);
        source.on('close', close);
        source.on('data', data);
        this.updateFlow();
    }

    diagnostic(line: string, stderr: Sink | null): void {
        // Recurring diagnostics must not create a queue behind a stalled sink.
        for (const sink of new Set(stderr ? [this.log, stderr] : [this.log])) {
            const state = this.sinks.get(sink)!;
            if (!state.blocked && !state.error && !sink.destroyed && !sink.writableEnded) this.write(sink, `${line}\n`);
        }
        this.updateFlow();
    }

    flush(): Promise<void> {
        if (this.failure) return Promise.reject(this.failure);
        if (this.cancelled || (this.sources.size === 0 && this.pendingWrites === 0)) return Promise.resolve();
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }

    cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        for (const [source, detach] of this.sources) { source.pause(); detach(); }
        this.sources.clear();
        for (const state of this.sinks.values()) { state.observers.delete(this.observer); state.release(); }
        this.checkFlushed();
    }

    private write(sink: Sink, chunk: Buffer | string): void {
        const state = this.sinks.get(sink)!;
        this.pendingWrites += 1;
        state.pendingWrites += 1;
        try {
            const accepted = sink.write(chunk, (error?: Error | null) => {
                this.pendingWrites -= 1;
                state.pendingWrites -= 1;
                if (error) { state.error = error; this.fail(error); }
                this.checkFlushed();
                if (this.cancelled) state.release();
            });
            if (!accepted) {
                state.blocked = true;
                for (const observer of Array.from(state.observers)) observer();
            }
        } catch (error) {
            this.pendingWrites -= 1;
            state.pendingWrites -= 1;
            state.error = error instanceof Error ? error : new Error(String(error));
            this.fail(state.error);
        }
    }

    private updateFlow(): void {
        if (this.cancelled) return;
        const blocked = Array.from(this.sinks.values()).some((state) => state.blocked);
        for (const source of this.sources.keys()) {
            if (blocked) source.pause();
            else source.resume();
        }
    }

    private fail(error: Error): void {
        if (this.failure || this.cancelled) return;
        this.failure = error;
        this.cancel();
        this.onError(error);
    }

    private checkFlushed(): void {
        if (!this.failure && !this.cancelled && (this.sources.size > 0 || this.pendingWrites > 0)) return;
        for (const waiter of this.waiters.splice(0)) {
            if (this.failure) waiter.reject(this.failure);
            else waiter.resolve();
        }
    }
}
