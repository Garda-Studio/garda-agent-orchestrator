// Child-only native CJS tests. The parent controls early bootstrap; no fabricated receipts.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { captureLoadedCodeClosure } from '../../../src/core/loaded-code-identity';
import { withInvocationReadObservation } from '../../../src/core/invocation-read-observation';
const scenario = process.argv[2], supplied = process.argv[3];
const root = supplied || fs.mkdtempSync(path.join(os.tmpdir(), 'garda-loaded-code-'));
const policy = path.join(root, 'policy.js'), dependency = path.join(root, 'dependency.js');
const bootstrap = require.resolve('../../../src/bin/garda/derivation-source-receipts');
const keyPath = path.join(root, 'fixture-key'), proofPath = path.join(root, 'proof.json');
function generic() {
    const loaded = require(policy) as { result(): string };
    return { loaded, code: captureLoadedCodeClosure('garda.test-policy-code.v1', [require.resolve(policy)]) };
}
function writePolicy() {
    fs.writeFileSync(dependency, "exports.value = 'A';\n");
    fs.writeFileSync(policy, "const dependency = require('./dependency'); exports.result = () => dependency.value;\n");
}
function copyRuntime() {
    const destination = path.join(root, 'runtime');
    fs.cpSync(path.resolve(__dirname, '../../../src'), destination, { recursive: true });
    return destination;
}
function mutate(file: string, before: string, after: string) {
    const text = fs.readFileSync(file, 'utf8'); assert.ok(text.includes(before), 'real compiled fixture must contain the selected implementation');
    fs.writeFileSync(file, text.replace(before, after));
}
try {
    if (scenario === 'seed') {
        writePolicy(); fs.writeFileSync(keyPath, randomBytes(32));
        const { loaded, code } = generic(); assert.equal(loaded.result(), 'A'); code.assertCurrent();
        const payload = JSON.stringify({ code: code.sha256, result: loaded.result() });
        fs.writeFileSync(proofPath, JSON.stringify({ payload, mac: createHmac('sha256', fs.readFileSync(keyPath)).update(payload).digest('hex') }));
    } else if (scenario === 'cold-hit') {
        const { loaded, code } = generic(); const envelope = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
        assert.equal(envelope.mac, createHmac('sha256', fs.readFileSync(keyPath)).update(envelope.payload).digest('hex'));
        const proof = JSON.parse(envelope.payload); code.assertCurrent();
        assert.equal(proof.code, code.sha256, 'A fresh process must actually accept the unchanged code binding.');
        assert.equal(proof.result, loaded.result());
    } else if (scenario === 'loaded-json-replaced') {
        const jsonFile = path.join(root, 'dependency.json');
        fs.writeFileSync(jsonFile, '{"value":"A"}');
        fs.writeFileSync(policy, "const dependency = require('./dependency.json'); exports.result = () => dependency.value;\n");
        const first = generic(); assert.equal(first.loaded.result(), 'A'); first.code.assertCurrent();
        fs.writeFileSync(jsonFile, '{"value":"B"}');
        assert.equal(first.loaded.result(), 'A');
        assert.throws(() => generic(), /Loaded code differs from current executable bytes/);
        assert.throws(() => first.code.assertCurrent(), /Loaded code differs|file identity changed/);
    } else if (scenario === 'native-json-error') {
        const io = require('node:fs') as typeof import('node:fs'), originalRead = io.readFileSync;
        const jsonFile = path.join(root, 'invalid.json'); fs.writeFileSync(jsonFile, '{invalid');
        assert.throws(() => require(jsonFile), SyntaxError);
        assert.equal(io.readFileSync, originalRead, 'Native JSON exception must restore the exact read function.');
        writePolicy(); generic().code.assertCurrent();
    } else if (scenario === 'loaded-dependency-replaced') {
        writePolicy(); const first = generic(); assert.equal(first.loaded.result(), 'A'); first.code.assertCurrent();
        fs.writeFileSync(dependency, "exports.value = 'B';\n");
        assert.equal(first.loaded.result(), 'A', 'The executing reducer is still A after disk becomes B.');
        assert.throws(() => generic(), /Loaded code differs from current executable bytes/);
        assert.throws(() => first.code.assertCurrent(), /Loaded code differs from current executable bytes|Loaded-code file identity changed/);
    } else if (scenario === 'final-source-replaced') {
        writePolicy(); require(policy);
        assert.throws(() => withInvocationReadObservation(() => {
            captureLoadedCodeClosure('garda.test-policy-code.v1', [require.resolve(policy)]);
            fs.writeFileSync(dependency, "exports.value = 'B';\n");
        }), /Invocation.*changed|Loaded code/);
    } else if (scenario === 'same-byte-file-replaced') {
        writePolicy(); const first = generic(); const bytes = fs.readFileSync(policy);
        fs.renameSync(policy, policy + '.original'); fs.writeFileSync(policy, bytes);
        assert.throws(() => first.code.assertCurrent(), /file identity changed/);
    } else if (scenario === 'custom-loader') {
        const nativeModule = require('node:module') as { prototype: { _compile(source: string, file: string): unknown } };
        const previous = nativeModule.prototype._compile;
        nativeModule.prototype._compile = function(source: string, file: string) { return Reflect.apply(previous, this, [source, file]); };
        require(bootstrap);
        assert.equal(Object.getOwnPropertyDescriptor(globalThis, Symbol.for('garda.loaded-source-receipts.v1')), undefined,
            'A non-native loader closure must not acquire a receipt authority.');
        writePolicy(); assert.equal((require(policy) as { result(): string }).result(), 'A');
    } else if (scenario === 'module-instance-replaced') {
        writePolicy(); const first = generic();
        delete require.cache[require.resolve(policy)]; require(policy);
        assert.throws(() => first.code.assertCurrent(), /module instance changed/);
    } else if (scenario === 'late-bootstrap') {
        writePolicy(); const loaded = require(policy) as { result(): string };
        require(bootstrap); // It may attest future loads, never modules already executed.
        assert.equal(loaded.result(), 'A');
        assert.throws(() => captureLoadedCodeClosure('garda.test-policy-code.v1', [require.resolve(policy)]), /receipt|unavailable/);
    } else if (scenario === 'no-bootstrap') {
        writePolicy(); const loaded = require(policy) as { result(): string };
        assert.equal(loaded.result(), 'A');
        assert.throws(() => captureLoadedCodeClosure('garda.test-policy-code.v1', [require.resolve(policy)]), /unavailable/);
    } else if (scenario === 'real-reducer-replaced' || scenario === 'real-renderer-replaced') {
        const runtime = copyRuntime(), reducer = scenario === 'real-reducer-replaced';
        const file = path.join(runtime, reducer ? 'gates/review-attempts/review-closed-cycle-summary.js' : 'gates/task-audit/task-audit-summary-final-report.js');
        const loaded = require(file) as { createClosedReviewProducerState(task: string): { lastReviewLineOrdinal: number }; formatReviewResultStatus(text: string): string };
        const value = () => reducer ? loaded.createClosedReviewProducerState('T-code').lastReviewLineOrdinal : loaded.formatReviewResultStatus('REVIEW PASSED');
        const original = value(); assert.equal(original, reducer ? -1 : 'findings-satisfied');
        const code = captureLoadedCodeClosure(reducer ? 'garda.closed-review-code-test.v1' : 'garda.terminal-code-test.v1', [file]);
        code.assertCurrent();
        if (reducer) mutate(file, 'lastReviewLineOrdinal: -1', 'lastReviewLineOrdinal: 0');
        else mutate(file, "return 'findings-satisfied';", "return 'changed-code-result';");
        assert.equal(value(), original, 'Actual native export remains loaded A while the executable file is B.');
        assert.throws(() => captureLoadedCodeClosure('garda.replaced-code-test.v1', [file]), /Loaded code differs from current executable bytes/);
        assert.throws(() => code.assertCurrent(), /Loaded code differs from current executable bytes|Loaded-code file identity changed/);
        const fresh = spawnSync(process.execPath, ['-r', bootstrap, __filename, reducer ? 'fresh-reducer' : 'fresh-renderer', root],
            { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
        assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    } else if (scenario === 'fresh-reducer' || scenario === 'fresh-renderer') {
        const reducer = scenario === 'fresh-reducer';
        const file = path.join(root, 'runtime', reducer ? 'gates/review-attempts/review-closed-cycle-summary.js' : 'gates/task-audit/task-audit-summary-final-report.js');
        const loaded = require(file) as { createClosedReviewProducerState(task: string): { lastReviewLineOrdinal: number }; formatReviewResultStatus(text: string): string };
        assert.equal(reducer ? loaded.createClosedReviewProducerState('T-code').lastReviewLineOrdinal : loaded.formatReviewResultStatus('REVIEW PASSED'), reducer ? 0 : 'changed-code-result');
        captureLoadedCodeClosure('garda.fresh-code-test.v1', [file]).assertCurrent();
    } else throw new Error('Unknown loaded-code scenario.');
} finally { if (!supplied) fs.rmSync(root, { recursive: true, force: true }); }
