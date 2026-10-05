import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCommandChain } from '../../src/core/command-line';
import { spawnStreamed, type SpawnStreamedOptions } from '../../src/core/subprocess';
import {
    beginValidationOutputRun,
    publishValidationCoverageReports
} from '../../src/core/validation-output-retention';
import { getRepoRoot } from './build';

export function resolveCoverageTestArgs(repoRoot: string, script: 'test' | 'test:fast', forwarded: string[]): string[] {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[script];
    if (!command) throw new Error(`Missing canonical ${script} script.`);
    const commands = parseCommandChain(command);
    const argv = commands[0];
    if (commands.length !== 1 || argv[0] !== 'node'
        || argv[1] !== 'scripts/node-foundation/build-scripts.cjs' || argv[2] !== 'test.js') {
        throw new Error(`Coverage requires the canonical guarded ${script} test runner.`);
    }
    // build-scripts holds its lock through this entry point. Re-entering it via npm test
    // would deadlock; the same build has already emitted the protected test.js entry.
    return [process.execPath, path.join(__dirname, 'test.js'), ...argv.slice(3), ...forwarded];
}

export async function runCoverageProcess(
    repoRoot: string,
    testArgs: string[],
    options: Pick<SpawnStreamedOptions, 'signal' | 'timeoutMs' | 'inheritStdio'> = {}
): Promise<number> {
    const run = beginValidationOutputRun(repoRoot, 'coverage');
    let exitCode = 1;
    let trackingError: unknown;
    try {
        const result = await spawnStreamed(process.execPath, [
            require.resolve('c8/bin/c8.js'),
            '--temp-directory', run.scratchDir,
            '--reports-dir', run.reportsDir,
            ...testArgs
        ], {
            cwd: repoRoot,
            inheritStdio: options.inheritStdio ?? true,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            onSpawn: child => {
                try { run.trackChild(child.pid ?? undefined); }
                catch (error) { trackingError = error; }
            }
        });
        if (trackingError) throw trackingError;
        exitCode = result.exitCode;
        publishValidationCoverageReports(repoRoot, run.reportsDir);
        return exitCode;
    } catch (error) {
        exitCode = 1;
        throw error;
    } finally {
        try { run.finish(exitCode); }
        catch (error) {
            console.warn(`COVERAGE_OUTPUT_CLEANUP_PENDING ${error instanceof Error ? error.message : 'storage unavailable'}`);
        }
    }
}

if (require.main === module) {
    const [script, ...forwarded] = process.argv.slice(2);
    if (script !== 'test' && script !== 'test:fast') {
        console.error('Usage: coverage.js <test|test:fast> [test arguments]');
        process.exitCode = 1;
    } else {
        const root = getRepoRoot();
        void runCoverageProcess(root, resolveCoverageTestArgs(root, script, forwarded)).then(
            code => { process.exitCode = code; },
            error => {
                console.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            }
        );
    }
}
