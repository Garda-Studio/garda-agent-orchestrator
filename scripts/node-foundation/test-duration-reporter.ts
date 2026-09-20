import * as fs from 'node:fs';
import { SHARD_DURATION_OUTPUT_ENV } from './test-duration-telemetry';

interface TestEvent {
    type: string;
    data: { file?: string; duration_ms?: number; success?: boolean; };
}

async function* durationReporter(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
    // Node reporters are async generators; this reporter is intentionally a sink and emits no output.
    yield* [] as string[];
    const destination = process.env[SHARD_DURATION_OUTPUT_ENV];
    let writable = Boolean(destination);
    for await (const event of source) {
        if (!writable || event.type !== 'test:summary' || !event.data.file || !event.data.success) continue;
        const durationMs = event.data.duration_ms;
        if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) continue;
        try {
            fs.appendFileSync(destination!, `${JSON.stringify({ file: event.data.file, durationMs })}\n`, 'utf8');
        } catch {
            // Optional measurements must never change the test result or interrupt the event stream.
            writable = false;
        }
    }
}

export = durationReporter;
