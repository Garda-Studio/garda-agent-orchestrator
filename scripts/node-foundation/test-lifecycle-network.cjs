'use strict';

process.env.GARDA_NPM_NETWORK_TESTS = '1';
process.argv = [process.execPath, __filename, 'test.js', '--test-name-pattern',
    'network-enabled npm acquisition', 'tests/node/lifecycle/check-update-runtime-policy.test.ts'];
require('./build-scripts.cjs').main();
