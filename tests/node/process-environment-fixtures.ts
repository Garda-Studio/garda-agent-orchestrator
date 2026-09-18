import type { FullSuiteValidationRunMarkerInspectionOptions } from '../../src/gates/full-suite/full-suite-validation-run-marker';

export const TEST_RUNNER_ENV_KEYS = [
    'GARDA_NODE_FOUNDATION_TEST_SHARDS',
    'GARDA_NODE_FOUNDATION_TEST_SHARD_LOG_DIR',
    'GARDA_NODE_FOUNDATION_TEST_SHARD_TIMEOUT_MS',
    'GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS',
    'GARDA_NODE_FOUNDATION_TEST_SHARD_CONCURRENCY',
    'GARDA_NODE_FOUNDATION_TEST_DURATION_FILE',
    'GARDA_NODE_FOUNDATION_TEST_PREBUILT',
    'GARDA_NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME',
    'GARDA_NODE_FOUNDATION_FORCE_REBUILD',
    'GARDA_BUILD_SCRIPTS_PROCESS_TIMEOUT_MS'
] as const;

function isTestRunnerEnvironmentKey(key: string): boolean {
    const normalized = key.toUpperCase();
    return normalized.startsWith('GARDA_NODE_FOUNDATION_') || normalized === 'GARDA_BUILD_SCRIPTS_PROCESS_TIMEOUT_MS';
}

export function isolateTestRunnerEnvironment(environment: NodeJS.ProcessEnv = process.env): () => void {
    const inherited = Object.entries(environment).filter(([key]) => isTestRunnerEnvironmentKey(key));
    const clear = () => {
        for (const key of Object.keys(environment).filter(isTestRunnerEnvironmentKey)) {
            delete environment[key];
        }
    };
    clear();
    let restored = false;
    return () => {
        if (restored) return;
        clear();
        for (const [key, value] of inherited) {
            environment[key] = value;
        }
        restored = true;
    };
}

export function createDeadProcessInspectionFixture(): FullSuiteValidationRunMarkerInspectionOptions {
    return { isProcessAlive: () => false, processTableSnapshot: { entries: [], warning: null } };
}
