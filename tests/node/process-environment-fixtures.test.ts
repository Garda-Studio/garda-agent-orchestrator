import assert from 'node:assert/strict';
import test from 'node:test';

import { isolateTestRunnerEnvironment, TEST_RUNNER_ENV_KEYS } from './process-environment-fixtures';

test('runner environment fixtures clear hostile inherited controls and restore every original value', () => {
    const environment: NodeJS.ProcessEnv = {
        UNRELATED_SETTING: 'preserved',
        GARDA_EXECUTION_PROVIDER: 'Codex',
        GARDA_NODE_FOUNDATION_FUTURE_CONTROL: 'inherited future value'
    };
    for (const key of TEST_RUNNER_ENV_KEYS) environment[key] = `hostile ${key}`;
    environment.GARDA_NODE_FOUNDATION_TEST_SHARD_HEARTBEAT_MS = '';
    const inherited = { ...environment };
    const restore = isolateTestRunnerEnvironment(environment);
    try {
        assert.deepEqual({ ...environment }, { UNRELATED_SETTING: 'preserved', GARDA_EXECUTION_PROVIDER: 'Codex' });
        environment.GARDA_NODE_FOUNDATION_TEST_SHARDS = '2';
        environment.GARDA_NODE_FOUNDATION_NEW_CONTROL = 'created by test';
    } finally {
        restore();
    }
    assert.deepEqual(environment, inherited);
});

test('runner environment fixtures restore absent keys after failures and support repeated nested use', () => {
    const environment: NodeJS.ProcessEnv = { GARDA_NODE_FOUNDATION_TEST_SHARDS: 'hostile inherited shards' };
    const inherited = { ...environment };
    for (let cycle = 0; cycle < 3; cycle += 1) {
        const restoreOuter = isolateTestRunnerEnvironment(environment);
        try {
            environment.GARDA_NODE_FOUNDATION_TEST_SHARDS = '2';
            const restoreInner = isolateTestRunnerEnvironment(environment);
            assert.throws(() => {
                try {
                    environment.GARDA_NODE_FOUNDATION_TEST_SHARD_CONCURRENCY = '999';
                    throw new Error('fixture body failed');
                } finally {
                    restoreInner();
                }
            }, /fixture body failed/u);
            assert.deepEqual({ ...environment }, { GARDA_NODE_FOUNDATION_TEST_SHARDS: '2' });
        } finally {
            restoreOuter();
        }
        assert.deepEqual(environment, inherited);
        environment.UNRELATED_SETTING = 'changed after cleanup';
        restoreOuter();
        assert.equal(environment.UNRELATED_SETTING, 'changed after cleanup');
        delete environment.UNRELATED_SETTING;
    }
});
