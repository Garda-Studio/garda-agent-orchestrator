import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

interface WorkflowStep {
    name?: string;
    id?: string;
    if?: string;
    uses?: string;
    with?: Record<string, unknown>;
    shell?: string;
    run?: string;
}

interface WorkflowJob {
    name?: string;
    steps?: WorkflowStep[];
    strategy?: { matrix?: { os?: string[] } };
}

interface WorkflowFile {
    jobs?: Record<string, WorkflowJob>;
}

function loadWorkflow(relativePath: string, label: string): WorkflowFile {
    const repoRoot = getRepoRoot();
    const workflowPath = path.join(repoRoot, relativePath);
    assert.ok(fs.existsSync(workflowPath), `${label} workflow must exist at ${workflowPath}`);
    const content = fs.readFileSync(workflowPath, 'utf8');
    // Lightweight YAML parsing: extract only what we need via line scanning.
    // Full yaml parsing would require a dependency; line-level checks are
    // sufficient for structural contract validation.
    return { _raw: content } as unknown as WorkflowFile & { _raw: string };
}

function loadCiWorkflow(): WorkflowFile {
    return loadWorkflow('.github/workflows/ci.yml', 'CI');
}

function loadScheduledSmokeWorkflow(): WorkflowFile {
    return loadWorkflow('.github/workflows/smoke-schedule.yml', 'Scheduled smoke');
}

function getRawContent(workflow: WorkflowFile): string {
    return (workflow as unknown as { _raw: string })._raw;
}

function getWorkflowJobBlock(raw: string, jobId: string): string {
    const lines = raw.split(/\r?\n/);
    const jobStart = lines.findIndex((line) => line === `  ${jobId}:`);
    assert.notEqual(jobStart, -1, `Workflow must define job '${jobId}'`);
    const nextJob = lines.findIndex((line, index) => index > jobStart && /^ {2}[A-Za-z0-9_-]+:\s*$/u.test(line));
    return lines.slice(jobStart, nextJob === -1 ? undefined : nextJob).join('\n');
}

function extractYamlListAfterKey(block: string, key: string): string[] {
    const lines = block.split(/\r?\n/);
    const keyPattern = new RegExp(`^(\\s*)${key}:\\s*$`, 'u');
    const keyIndex = lines.findIndex((line) => keyPattern.test(line));
    assert.notEqual(keyIndex, -1, `Expected YAML key '${key}'`);
    const keyIndent = keyPattern.exec(lines[keyIndex])![1].length;
    const values: string[] = [];
    for (const line of lines.slice(keyIndex + 1)) {
        const indent = line.match(/^\s*/u)![0].length;
        if (line.trim() && indent <= keyIndent) {
            break;
        }
        const item = /^\s*-\s*(.+?)\s*$/u.exec(line);
        if (item) {
            values.push(item[1].replace(/^['"]|['"]$/gu, ''));
        }
    }
    return values;
}

function assertSupportedNodeMatrix(raw: string, jobId: string, label: string): void {
    const jobBlock = getWorkflowJobBlock(raw, jobId);
    assert.deepEqual(
        extractYamlListAfterKey(jobBlock, 'node-version'),
        ['22.13.0', '24'],
        `${label} must run on Node 22.13.0 and Node 24`
    );
}

test('CI workflow smoke job exists', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(raw, /^\s+smoke:/m, 'CI workflow must define a smoke job');
});

test('CI workflow smoke job covers supported Node runtime lines', () => {
    const raw = getRawContent(loadCiWorkflow());
    const smokeJob = getWorkflowJobBlock(raw, 'smoke');

    assert.match(smokeJob, /name:\s*Smoke \/ \$\{\{\s*matrix\.os\s*}} \/ Node \$\{\{\s*matrix\.node-version\s*}}/);
    assertSupportedNodeMatrix(raw, 'smoke', 'CI smoke job');
});

test('scheduled smoke workflow covers supported Node runtime lines', () => {
    const raw = getRawContent(loadScheduledSmokeWorkflow());
    const smokeJob = getWorkflowJobBlock(raw, 'smoke');

    assert.match(raw, /^\s+smoke:/m, 'Scheduled smoke workflow must define a smoke job');
    assert.match(smokeJob, /name:\s*Smoke \/ \$\{\{\s*matrix\.os\s*}} \/ Node \$\{\{\s*matrix\.node-version\s*}}/);
    assert.deepEqual(
        extractYamlListAfterKey(smokeJob, 'os'),
        ['ubuntu-latest', 'windows-latest', 'macos-latest']
    );
    assertSupportedNodeMatrix(raw, 'smoke', 'Scheduled smoke job');
});

test('lifecycle smoke commits the prebuilt bundle atop the checked-out commit', () => {
    const workflows = [
        ['CI', getWorkflowJobBlock(getRawContent(loadCiWorkflow()), 'smoke')],
        ['Scheduled smoke', getWorkflowJobBlock(getRawContent(loadScheduledSmokeWorkflow()), 'smoke')]
    ] as const;

    for (const [label, smokeJob] of workflows) {
        assert.ok(
            smokeJob.includes('SMOKE_BRANCH="garda-ci-smoke-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"'),
            `${label} must use a run-scoped local smoke branch`
        );
        assert.match(
            smokeJob,
            /git -C "\$GITHUB_WORKSPACE" branch --force "\$SMOKE_BRANCH" "\$GITHUB_SHA"/u,
            `${label} must anchor the smoke branch to the exact checked-out commit`
        );
        assert.match(smokeJob, /git -C "\$GITHUB_WORKSPACE" add -f -- dist bin\/garda\.js/u,
            `${label} must stage the prebuilt runtime`);
        assert.match(smokeJob, /git -C "\$GITHUB_WORKSPACE" branch --force "\$SMOKE_BRANCH" HEAD/u,
            `${label} must update from the commit containing the prebuilt runtime`);
        assert.match(smokeJob, /GIT_URL="\$GITHUB_WORKSPACE"/u,
            `${label} must clone from an explicit local path`);
        assert.match(
            smokeJob,
            /update git .* --branch "\$SMOKE_BRANCH"/u,
            `${label} must update from the run-scoped smoke branch`
        );
        assert.doesNotMatch(
            smokeJob,
            /GITHUB_HEAD_REF|GITHUB_REF_NAME/u,
            `${label} must not assume the event branch exists in a shallow checkout`
        );
    }
});

test('smoke job lifecycle step has an id for output forwarding', () => {
    const raw = getRawContent(loadCiWorkflow());
    // The lifecycle step must have `id: lifecycle-smoke` so the forensics
    // collection step can reference its outputs.
    assert.match(
        raw,
        /id:\s*lifecycle-smoke/,
        'Lifecycle smoke step must have id: lifecycle-smoke'
    );
});

test('smoke job lifecycle step exports smoke_dir to GITHUB_OUTPUT', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /smoke_dir=.*>>\s*.*GITHUB_OUTPUT/,
        'Lifecycle smoke step must export smoke_dir to $GITHUB_OUTPUT'
    );
});

test('smoke job has failure-conditional evidence collection step', () => {
    const raw = getRawContent(loadCiWorkflow());
    // Must have a step that creates the smoke-failure-evidence directory
    assert.match(
        raw,
        /name:\s*Collect smoke failure evidence/,
        'Smoke job must have a "Collect smoke failure evidence" step'
    );
    // The collection step must run on failure only
    assert.match(
        raw,
        /if:\s*failure\(\)/,
        'Evidence collection step must use if: failure() condition'
    );
});

test('smoke job has failure-conditional artifact upload step', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /name:\s*Upload smoke failure evidence/,
        'Smoke job must have an "Upload smoke failure evidence" step'
    );
    assert.match(
        raw,
        /uses:\s*actions\/upload-artifact@v7\.0\.1/,
        'Upload step must use actions/upload-artifact@v7.0.1'
    );
});

test('evidence collection captures npm debug logs', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /\.npm\/_logs/,
        'Evidence collection must capture npm debug logs from ~/.npm/_logs/'
    );
});

test('evidence collection captures orchestrator runtime state', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /garda-agent-orchestrator\/runtime/,
        'Evidence collection must capture orchestrator runtime artifacts'
    );
});

test('evidence collection captures runner environment snapshot', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /runner-env\.txt/,
        'Evidence collection must produce a runner-env.txt snapshot'
    );
});

test('upload artifact uses per-OS naming', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /smoke-failure-evidence-\$\{\{\s*matrix\.os\s*}}/,
        'Artifact name must include matrix.os for per-platform disambiguation'
    );
});

test('upload artifact has bounded retention', () => {
    const raw = getRawContent(loadCiWorkflow());
    assert.match(
        raw,
        /retention-days:\s*\d+/,
        'Upload artifact must specify retention-days to bound storage cost'
    );
});
