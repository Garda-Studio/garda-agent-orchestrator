import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { queryNpmUpdateMetadata } from '../../../src/lifecycle/check-update/check-update-source';
import { createUpdateAvailabilityService } from '../../../src/lifecycle/update-availability/update-availability-service';

function fixture(t: TestContext): { root: string; calls: string; metadata: { version: string; integrity: string } } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-availability-transport-'));
    const bundle = path.join(root, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'VERSION'), '1.4.3');
    fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }));
    const metadata = { version: '1.4.4', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` };
    const calls = path.join(root, 'npm-calls.jsonl');
    const fakeNpm = path.join(root, 'npm-cli.js');
    fs.writeFileSync(fakeNpm, `const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');
const mode=process.env.GARDA_TEST_METADATA_MODE;
if(mode==='exit'){process.stderr.write('private fixture diagnostic');process.exit(7);}
else if(mode==='truncated'){process.stdout.write('x'.repeat(20000));}
else if(mode==='invalid'){process.stdout.write(JSON.stringify({version:'invalid', 'dist.integrity':'bad'}));}
else if(mode==='hung'){setInterval(()=>{},1000);}
else process.stdout.write(JSON.stringify({version:${JSON.stringify(metadata.version)},'dist.integrity':${JSON.stringify(metadata.integrity)}}));`);
    const oldNpm = process.env.npm_execpath;
    const oldMode = process.env.GARDA_TEST_METADATA_MODE;
    process.env.npm_execpath = fakeNpm;
    delete process.env.GARDA_TEST_METADATA_MODE;
    t.after(() => {
        if (oldNpm === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = oldNpm;
        if (oldMode === undefined) delete process.env.GARDA_TEST_METADATA_MODE; else process.env.GARDA_TEST_METADATA_MODE = oldMode;
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, calls, metadata };
}

test('production adapter requests only validated npm version/integrity metadata', async t => {
    const { root, calls, metadata } = fixture(t);
    const result = await queryNpmUpdateMetadata({ packageSpec: 'garda-agent-orchestrator@latest', cwd: root, signal: new AbortController().signal, timeoutMs: 4000 });
    assert.deepEqual(result, metadata);
    assert.deepEqual(JSON.parse(fs.readFileSync(calls, 'utf8').trim()), [
        'view', 'garda-agent-orchestrator@latest', 'version', 'dist.integrity', '--json', '--fetch-retries=0'
    ]);
    assert.equal((await createUpdateAvailabilityService(root, { automaticEnabled: true }).check()).status, 'available');
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 2);
});

test('production adapter rejects exit failures, malformed metadata and truncated output', async t => {
    const { root } = fixture(t);
    for (const mode of ['exit', 'invalid', 'truncated']) {
        process.env.GARDA_TEST_METADATA_MODE = mode;
        await assert.rejects(queryNpmUpdateMetadata({ packageSpec: 'garda-agent-orchestrator@latest', cwd: root, signal: new AbortController().signal, timeoutMs: 4000 }));
        const view = await createUpdateAvailabilityService(root, { automaticEnabled: true }).check({ manual: true });
        assert.equal(view.status, 'unavailable');
        assert.doesNotMatch(JSON.stringify(view), /private fixture diagnostic/);
    }
});

test('production adapter respects cancellation and kills an overlong metadata subprocess', async t => {
    const { root } = fixture(t);
    process.env.GARDA_TEST_METADATA_MODE = 'hung';
    const controller = new AbortController();
    const cancelled = queryNpmUpdateMetadata({ packageSpec: 'garda-agent-orchestrator@latest', cwd: root, signal: controller.signal, timeoutMs: 4000 });
    controller.abort();
    await assert.rejects(cancelled);
    await assert.rejects(queryNpmUpdateMetadata({ packageSpec: 'garda-agent-orchestrator@latest', cwd: root, signal: new AbortController().signal, timeoutMs: 100 }));
});
