import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveGardaCliPrefix } from '../../../src/core/garda-cli-prefix';
import { PUBLIC_BUNDLE_ASSETS, RETIRED_PUBLIC_BUNDLE_ASSETS } from '../../../src/core/public-bundle-assets';
import { INSTALLED_BUNDLE_GUIDANCE } from '../../../src/gates/protected-control-plane/installed-bundle-guard';
import { buildRestoreCommands } from '../../../src/gates/split-required/split-required-wip-contracts';

describe('runtime guidance CLI prefix', () => {
    it('names the deployed CLI in installed projects and the source CLI only next to bin/garda.js', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-prefix-'));
        try {
            assert.equal(resolveGardaCliPrefix(root), 'node garda-agent-orchestrator/bin/garda.js');
            fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
            fs.writeFileSync(path.join(root, 'bin', 'garda.js'), '\n');
            assert.equal(resolveGardaCliPrefix(root), 'node bin/garda.js');
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    it('builds split-required WIP restore commands with the resolved prefix', () => {
        const commands = buildRestoreCommands('T-001', 'garda-agent-orchestrator/runtime/wip/T-001.json',
            'node garda-agent-orchestrator/bin/garda.js');
        for (const command of Object.values(commands)) {
            assert.match(command, /^node garda-agent-orchestrator\/bin\/garda\.js gate /u);
        }
    });

    it('never lists a bundle asset as both shipped and retired', () => {
        // An overlap would plan one path twice and the update sentinel's uniqueness check would block every update.
        const shipped = new Set<string>(PUBLIC_BUNDLE_ASSETS);
        assert.deepEqual(RETIRED_PUBLIC_BUNDLE_ASSETS.filter((item) => shipped.has(item)), []);
    });

    it('keeps installed-bundle guidance free of Garda source-checkout instructions', () => {
        assert.doesNotMatch(INSTALLED_BUNDLE_GUIDANCE, /source[- ]checkout|node bin\/garda\.js/iu);
    });
});
