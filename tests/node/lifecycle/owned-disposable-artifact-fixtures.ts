import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runRetainedProducer } from './fixtures/retained-producer-process';
import { buildTaskModeArtifact } from '../../../src/gates/task-mode';
import { previewOwnedDisposableArtifacts } from '../../../src/lifecycle/cleanup';
import { buildOwnedDisposableArtifactSnapshot } from '../../../src/lifecycle/cleanup/owned-disposable-artifact-preview';
import { buildTaskAuditSummary, computeFileSha256, getWorkspaceSnapshot, makeTempDir,
    synchronizeFinalCloseoutArtifacts, writeArtifact, writeIntegrityEventSequence, writePreflight, writeWorkflowConfig }
    from '../gates/task-audit/task-audit-summary-fixtures';
import { initGitRepo } from '../gates/git-fixtures';
import { writeTaskQueue, writeTimelineSummary } from './cleanup-fixtures';

// Test-only native evidence builders; no production workspace receipts or grants are created.
export const taskId = 'T-DISPOSABLE-1';

export function fixture(t: TestContext) {
    const targetRoot = makeTempDir(), bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    t.after(() => fs.rmSync(targetRoot, { recursive: true, force: true }));
    fs.writeFileSync(path.join(targetRoot, 'example.txt'), 'baseline\n');
    initGitRepo(targetRoot, { gitignoreContent: 'garda-agent-orchestrator/\nTASK.md\n' });
    fs.writeFileSync(path.join(targetRoot, 'example.txt'), 'accepted content\n');
    const runtime = path.join(bundleRoot, 'runtime'), events = path.join(runtime, 'task-events'), reviews = path.join(runtime, 'reviews');
    fs.mkdirSync(events, { recursive: true }); fs.mkdirSync(reviews, { recursive: true });
    writeWorkflowConfig(targetRoot, false); writeTaskQueue(targetRoot, [{ id: taskId, status: 'DONE' }]);
    const metrics = getWorkspaceSnapshot(targetRoot, 'explicit_changed_files', true, ['example.txt']);
    writePreflight(reviews, taskId, { task_id: taskId, mode: 'FULL_PATH', detection_source: 'explicit_changed_files',
        changed_files: ['example.txt'], metrics, required_reviews: {} });
    const preflight = path.join(reviews, `${taskId}-preflight.json`), hash = computeFileSha256(preflight);
    const mode = buildTaskModeArtifact({ taskId, entryMode: 'EXPLICIT_TASK_EXECUTION', requestedDepth: 2, effectiveDepth: 2,
        taskSummary: 'Disposable preview fixture', provider: 'Codex', canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider', runtimeIdentityStatus: 'resolved', reviewerSubagentLaunchStatus: 'launchable' });
    writeArtifact(reviews, taskId, '-task-mode.json', mode);
    for (const suffix of ['-compile-gate.json', '-review-gate.json', '-doc-impact.json']) {
        writeArtifact(reviews, taskId, suffix, { task_id: taskId, status: 'PASSED', preflight_sha256: hash, decision: 'NO_DOC_UPDATES' });
    }
    writeIntegrityEventSequence(events, taskId, [
        { event_type: 'TASK_MODE_ENTERED', details: { artifact_path: path.join(reviews, `${taskId}-task-mode.json`) } },
        { event_type: 'RULE_PACK_LOADED' }, { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED' }, { event_type: 'SHELL_SMOKE_PREFLIGHT_RECORDED' },
        { event_type: 'PREFLIGHT_CLASSIFIED', details: { artifact_path: preflight, artifact_hash: hash } },
        { event_type: 'COMPILE_GATE_PASSED', details: { preflight_path: preflight, preflight_sha256: hash } },
        { event_type: 'REVIEW_GATE_PASSED' }, { event_type: 'DOC_IMPACT_ASSESSED' },
        { event_type: 'STATUS_CHANGED', details: { new_status: 'DONE' } }, { event_type: 'COMPLETION_GATE_PASSED' }
    ]);
    writeTimelineSummary(events, taskId, { completenessStatus: 'COMPLETE' });
    execFileSync('git', ['add', '--', 'example.txt'], { cwd: targetRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'accepted preview fixture'], { cwd: targetRoot, stdio: 'ignore' });
    const audit = buildTaskAuditSummary({ repoRoot: targetRoot, taskId });
    assert.equal(audit.status, 'PASS', JSON.stringify(audit.blockers)); synchronizeFinalCloseoutArtifacts(audit);
    const options = { targetRoot, bundleRoot, taskId };
    function produce(seal = true) {
        const producer = runRetainedProducer(t,
            'const api=require(process.argv[1]), fs=require("node:fs"), path=require("node:path"), options=JSON.parse(process.argv[2]);'
            + 'const result=api.registerOwnedDisposableArtifact({...options,category:"raw-stdout"});'
            + 'fs.writeFileSync(path.join(result.payloadPath,"alpha.txt"),"abc");'
            + 'fs.mkdirSync(path.join(result.payloadPath,"nested"));'
            + 'fs.writeFileSync(path.join(result.payloadPath,"nested","bytes.bin"),Buffer.from([0,1,2,3]));'
            + 'if(process.argv[3]==="yes")api.sealOwnedDisposableArtifact({...options,registrationId:result.registrationId});'
            + 'process.stdout.write(JSON.stringify(result));',
            { args: [require.resolve('../../../src/lifecycle/cleanup/owned-disposable-artifact-registration'),
                JSON.stringify(options), seal ? 'yes' : 'no'], timeout: 15_000, maxBuffer: 64 * 1024 });
        assert.equal(producer.error, undefined); assert.equal(producer.status, 0, producer.stderr);
        return JSON.parse(producer.stdout) as { registrationId: string; payloadPath: string; ownerPath: string };
    }
    function preview(...registrationIds: string[]) { return previewOwnedDisposableArtifacts({ ...options, registrationIds }); }
    function produceBare(nested: boolean) {
        const owned = produce(), before = buildOwnedDisposableArtifactSnapshot({ ...options, registrationIds: [owned.registrationId] });
        const repository = nested ? path.join(owned.payloadPath, 'cached-data') : owned.payloadPath;
        execFileSync('git', ['-c', 'core.longpaths=true', 'init', '--bare', '--template=', repository], { stdio: 'ignore' });
        const isBare = () => execFileSync('git', ['-c', 'core.longpaths=true', '-C', repository, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim();
        const protectedFiles = [path.join(repository, 'HEAD'), path.join(repository, 'config'),
            path.join(owned.payloadPath, 'alpha.txt'), path.join(owned.payloadPath, 'nested', 'bytes.bin'),
            path.join(runtime, 'task-ledger', `${taskId}.json`)];
        return { owned, before, repository, isBare, protectedFiles, hashes: protectedFiles.map(computeFileSha256) };
    }
    return { ...options, runtime, events, reviews, options, produce, produceBare, preview };
}

