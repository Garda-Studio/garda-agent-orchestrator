import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isBundleRootLike, resolveBundleNameForTarget, DEFAULT_BUNDLE_NAME } from '../../../src/core/constants';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';

test('Q3 bundle selection retains missing markers and rejects their appearance before output', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-q3-bundle-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bundle = path.join(root, DEFAULT_BUNDLE_NAME);
    fs.mkdirSync(path.join(bundle, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'package.json'), '{}'); fs.writeFileSync(path.join(bundle, 'bin/garda.js'), '');
    assert.throws(() => withInvocationReadObservation(() => {
        assert.equal(isBundleRootLike(bundle), false);
        assert.equal(resolveBundleNameForTarget(root), DEFAULT_BUNDLE_NAME);
        fs.writeFileSync(path.join(bundle, 'VERSION'), '1.4.4');
        assert.equal(isBundleRootLike(bundle), false);
    }), /changed|stale|identity|replaced/i);
    assert.equal(isBundleRootLike(bundle), true);
});
