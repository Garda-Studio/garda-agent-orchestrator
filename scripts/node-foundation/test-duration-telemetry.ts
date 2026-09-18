import * as fs from 'node:fs';
import * as path from 'node:path';

export const SHARD_DURATION_OUTPUT_ENV = 'GARDA_NODE_FOUNDATION_SHARD_DURATION_OUTPUT';
const MAX_DURATION_RECORD_BYTES = 4_096;

export interface FileDurationObservation {
    file: string;
    durationMs: number;
}

export interface DurationWeightInput {
    durationMs: number | null;
    fallbackSize: number;
}

export function calibrateDurationWeights<T extends DurationWeightInput>(inputs: T[]): (T & {
    weight: number;
    estimatedDurationMs: number | null;
})[] {
    const ratios = inputs.filter((item) => item.durationMs !== null)
        .map((item) => item.durationMs! / item.fallbackSize).sort((a, b) => a - b);
    const middle = Math.floor(ratios.length / 2);
    const msPerByte = ratios.length === 0 ? null : ratios.length % 2 === 0
        ? (ratios[middle - 1] + ratios[middle]) / 2 : ratios[middle];
    return inputs.map((item) => {
        const estimatedDurationMs = item.durationMs ?? (msPerByte === null
            ? null : Math.max(1, Math.ceil(item.fallbackSize * msPerByte)));
        return { ...item, weight: estimatedDurationMs ?? item.fallbackSize, estimatedDurationMs };
    });
}

export function formatDurationForecastAccuracy(estimatedWallMs: number, observedWallMs: number): string {
    return `observed_wall_ms=${observedWallMs} estimated_wall_error_ms=${observedWallMs - estimatedWallMs} `
        + `observed_to_estimated_ratio=${estimatedWallMs > 0 ? (observedWallMs / estimatedWallMs).toFixed(2) : 'unavailable'}`;
}

export function addDurationReporterOptions(
    optionArgs: string[],
    reporterPath: string,
    nodeMajorVersion = Number(process.versions.node.split('.')[0])
): string[] {
    let reporters = 0;
    let destinations = 0;
    for (let index = 0; index < optionArgs.length; index += 1) {
        const arg = optionArgs[index];
        if (arg === '--test-reporter' || arg.startsWith('--test-reporter=')) reporters += 1;
        if (arg === '--test-reporter-destination' || arg.startsWith('--test-reporter-destination=')) destinations += 1;
        if (arg === '--test-reporter' || arg === '--test-reporter-destination'
            || arg === '--test-name-pattern' || arg === '--test-skip-pattern') index += 1;
    }
    // Preserve Node's validation of invalid reporter/destination combinations.
    if ((reporters > 1 && destinations !== reporters) || destinations > Math.max(1, reporters)) return optionArgs;
    const args = [...optionArgs];
    if (reporters === 0) args.push(`--test-reporter=${nodeMajorVersion === 22 ? 'tap' : 'spec'}`);
    if (destinations === 0) args.push('--test-reporter-destination=stdout');
    args.push(`--test-reporter=${reporterPath}`, '--test-reporter-destination=stdout');
    return args;
}

export function createShardDurationCapture(shardLogDir: string, shardFiles: string[]): {
    destination: string;
    finish: () => FileDurationObservation[];
} | null {
    let captureRoot: string;
    try {
        captureRoot = fs.mkdtempSync(path.join(shardLogDir, 'durations-'));
    } catch {
        return null;
    }
    const destination = path.join(captureRoot, 'files.jsonl');
    return {
        destination,
        finish: () => {
            let handle: number | null = null;
            try {
                const maximumBytes = Math.max(1, shardFiles.length) * MAX_DURATION_RECORD_BYTES;
                handle = fs.openSync(destination, 'r');
                const size = fs.fstatSync(handle).size;
                if (size > maximumBytes) return [];
                const buffer = Buffer.alloc(size + 1);
                let bytesRead = 0;
                while (bytesRead < buffer.length) {
                    const count = fs.readSync(handle, buffer, bytesRead, buffer.length - bytesRead, null);
                    if (count === 0) break;
                    bytesRead += count;
                }
                if (bytesRead > size) return [];
                const allowedFiles = new Map(shardFiles.map((file) => [path.resolve(file), file]));
                const observations = new Map<string, FileDurationObservation>();
                for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
                    if (!line) continue;
                    const parsed = JSON.parse(line) as FileDurationObservation;
                    if (!parsed || typeof parsed.file !== 'string' || typeof parsed.durationMs !== 'number'
                        || !Number.isFinite(parsed.durationMs) || parsed.durationMs <= 0) continue;
                    const file = allowedFiles.get(path.resolve(parsed.file));
                    if (file) observations.set(file, { file, durationMs: parsed.durationMs });
                }
                return [...observations.values()];
            } catch {
                return [];
            } finally {
                if (handle !== null) { try { fs.closeSync(handle); } catch { /* Optional capture cleanup. */ } }
                try { fs.unlinkSync(destination); } catch { /* Optional capture cleanup. */ }
                try { fs.rmdirSync(captureRoot); } catch { /* Preserve unexpected capture contents. */ }
            }
        }
    };
}
