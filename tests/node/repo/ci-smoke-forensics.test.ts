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

function loadManualSmokeWorkflow(): WorkflowFile {
    return loadWorkflow('.github/workflows/smoke-schedule.yml', 'Manual smoke');
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

function getWorkflowStepBlock(job: string, name: string): string {
    const lines = job.split(/\r?\n/);
    const start = lines.findIndex((line) => line === `      - name: ${name}`);
    assert.notEqual(start, -1, `Workflow job must define step '${name}'`);
    const end = lines.findIndex((line, index) => index > start && /^ {6}-\s/u.test(line));
    return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

function assertSmokeUpload(job: string): void {
    const step = getWorkflowStepBlock(job, 'Upload smoke failure evidence');
    assert.match(step, /^ {8}if: failure\(\)$/mu, 'Smoke upload must run on failure');
    assert.match(
        step,
        /^ {8}uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a +# v7\.0\.1$/mu,
        'Smoke upload must use the immutable actions/upload-artifact v7.0.1 pin'
    );
}

function assertSmokeForensics(job: string): void {
    const lifecycle = getWorkflowStepBlock(job, 'Lifecycle smoke (cross-platform E2E install → update → uninstall)');
    assert.match(lifecycle, /^ {8}id: lifecycle-smoke$/mu);
    assert.ok(lifecycle.split(/\r?\n/u).map(line => line.trim())
        .includes('echo "smoke_dir=$SMOKE_DIR" >> "$GITHUB_OUTPUT"'));
    const collection = getWorkflowStepBlock(job, 'Collect smoke failure evidence');
    assert.match(collection, /^ {8}if: failure\(\)$/mu, 'Smoke collection must run on failure');
    const lines = collection.split(/\r?\n/u).map(line => line.trim());
    for (const required of [
        'mkdir -p smoke-failure-evidence',
        'for log in "$HOME"/.npm/_logs/*.log; do',
        '[ -f "$log" ] && cp "$log" smoke-failure-evidence/ || true',
        'SMOKE_DIR="${{ steps.lifecycle-smoke.outputs.smoke_dir }}"',
        'cp -r "$SMOKE_DIR/garda-agent-orchestrator/runtime" smoke-failure-evidence/smoke-runtime',
        'cp -r "$SMOKE_DIR/garda-agent-orchestrator/live/config" smoke-failure-evidence/smoke-config',
        'echo "runner_os=$RUNNER_OS"',
        'echo "smoke_dir=$SMOKE_DIR"',
        '} > smoke-failure-evidence/runner-env.txt'
    ]) assert.ok(lines.includes(required), 'Missing executable Smoke evidence statement: ' + required);
    assertSmokeUpload(job);
    const uploadLines = getWorkflowStepBlock(job, 'Upload smoke failure evidence').split(/\r?\n/u)
        .map(line => line.trim());
    for (const required of [
        'name: smoke-failure-evidence-${{ matrix.os }}-node${{ matrix.node-version }}',
        'path: smoke-failure-evidence/',
        'retention-days: 15',
        'if-no-files-found: ignore'
    ]) assert.ok(uploadLines.includes(required), 'Missing Smoke upload contract: ' + required);
}

function assertReleasePreparation(job: string): void {
    const build = getWorkflowStepBlock(job, 'Prepare embedded release bundle');
    const bootstrap = getWorkflowStepBlock(job, 'Bootstrap embedded release bundle');
    const validation = getWorkflowStepBlock(job, 'Validate release');
    assert.match(build, /^ {8}run: npm run build$/mu);
    assert.match(bootstrap, /^ {8}run: node bin\/garda\.js bootstrap --destination garda-agent-orchestrator$/mu);
    assert.match(validation, /^ {8}run: npm run validate:release:fast$/mu);
    for (const step of [build, bootstrap, validation]) {
        assert.doesNotMatch(step, /^ {8}if:|continue-on-error:/mu);
    }
    assert.ok(job.indexOf(build) < job.indexOf(bootstrap));
    assert.ok(job.indexOf(bootstrap) < job.indexOf(validation));
}

test('release validation prepares the actual embedded bundle before mandatory parity', () => {
    assertReleasePreparation(getWorkflowJobBlock(getRawContent(loadCiWorkflow()), 'validate-release'));
});

test('release preparation assertions reject skipped, reordered or neighboring-only preparation', () => {
    const job = getWorkflowJobBlock(getRawContent(loadCiWorkflow()), 'validate-release');
    const build = getWorkflowStepBlock(job, 'Prepare embedded release bundle');
    const bootstrap = getWorkflowStepBlock(job, 'Bootstrap embedded release bundle');
    const decoy = bootstrap.replace('Bootstrap embedded release bundle', 'Unrelated bootstrap');
    for (const invalid of [
        job.replace(bootstrap, bootstrap.replace('--destination garda-agent-orchestrator', '--destination unrelated')),
        job.replace(bootstrap, bootstrap.replace('        run:', "        if: false\n        run:")),
        job.replace(build, '__BUILD_STEP__').replace(bootstrap, build).replace('__BUILD_STEP__', bootstrap)
    ]) {
        assert.throws(() => assertReleasePreparation(invalid + '\n' + decoy));
    }
});

function ripgrepVerificationLines(platform: 'Linux' | 'Windows'): string[] {
    return platform === 'Linux' ? [
        'rg_binary_sha256=e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849',
        `if ! printf '%s  %s\\n' 33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c "$rg_archive" | sha256sum --check --status; then`,
        'tar -xzf "$rg_archive" -C "$rg_setup_root"',
        `if ! printf '%s  %s\\n' "$rg_binary_sha256" "$rg_executable" | sha256sum --check --status; then`,
        'dirname "$rg_executable" >> "$GITHUB_PATH"',
        '"$rg_executable" --version'
    ] : [
        "$rgBinarySha256 = '14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680'",
        "if ((Get-FileHash -LiteralPath $rgArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5') {",
        'Expand-Archive -LiteralPath $rgArchive -DestinationPath $rgSetupRoot',
        'if ((Get-FileHash -LiteralPath $rgExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $rgBinarySha256) {',
        'Split-Path -Parent $rgExecutable | Add-Content -LiteralPath $env:GITHUB_PATH -Encoding utf8',
        '& $rgExecutable --version'
    ];
}

function assertRipgrepVerificationOrder(step: string, platform: 'Linux' | 'Windows'): void {
    const lines = step.split(/\r?\n/u).map(line => line.trim());
    const indexes = ripgrepVerificationLines(platform).map(line => {
        const index = lines.indexOf(line);
        assert.notEqual(index, -1, 'Missing executable verification statement: ' + line);
        assert.equal(lines.lastIndexOf(line), index, 'Verification statement must occur exactly once: ' + line);
        return index;
    });
    for (let index = 1; index < indexes.length; index++) {
        assert.ok(indexes[index - 1] < indexes[index], 'Archive verification, extraction, binary verification, PATH publication and execution must stay ordered');
    }
}

test('compact CI tool preparation pins official archives and executables before use', () => {
    const raw = getRawContent(loadCiWorkflow());
    const linuxSteps = [
        getWorkflowStepBlock(getWorkflowJobBlock(raw, 'test-unit'), 'Install ripgrep for compact integration tests'),
        getWorkflowStepBlock(getWorkflowJobBlock(raw, 'validate-release'), 'Install ripgrep for compact integration tests (Linux)')
    ];
    for (const step of linuxSteps) {
        assert.match(step, /ripgrep\/releases\/download\/15\.2\.0\/ripgrep-15\.2\.0-x86_64-unknown-linux-musl\.tar\.gz/u);
        assert.match(step, /33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c/u);
        assert.match(step, /e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849/u);
        assertRipgrepVerificationOrder(step, 'Linux');
        assert.match(step, /Ripgrep archive checksum mismatch/u);
        assert.match(step, /Ripgrep executable checksum mismatch/u);
        assert.match(step, /Ripgrep setup duration:/u);
        assert.doesNotMatch(step, /apt-get|continue-on-error:/u);
    }
    const windows = getWorkflowStepBlock(
        getWorkflowJobBlock(raw, 'validate-release'), 'Install ripgrep for compact integration tests (Windows)');
    assert.match(windows, /ripgrep\/releases\/download\/15\.2\.0\/ripgrep-15\.2\.0-x86_64-pc-windows-msvc\.zip/u);
    assert.match(windows, /71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5/u);
    assert.match(windows, /14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680/u);
    assert.match(windows, /Get-Command rg .*\| Select-Object -First 1/u);
    assertRipgrepVerificationOrder(windows, 'Windows');
    assert.match(windows, /Ripgrep setup duration:/u);
    assert.doesNotMatch(windows, /choco install|continue-on-error:/u);
});

test('ripgrep assertions reject missing, commented or reordered real checks despite retained diagnostics', () => {
    const raw = getRawContent(loadCiWorkflow());
    const cases: [string, 'Linux' | 'Windows'][] = [
        [getWorkflowStepBlock(getWorkflowJobBlock(raw, 'test-unit'), 'Install ripgrep for compact integration tests'), 'Linux'],
        [getWorkflowStepBlock(getWorkflowJobBlock(raw, 'validate-release'), 'Install ripgrep for compact integration tests (Linux)'), 'Linux'],
        [getWorkflowStepBlock(getWorkflowJobBlock(raw, 'validate-release'), 'Install ripgrep for compact integration tests (Windows)'), 'Windows']
    ];
    for (const [step, platform] of cases) {
        const [, archive, extraction, executable, , execution] = ripgrepVerificationLines(platform);
        const movedAfterExtraction = step.replace(archive, '# moved archive check').replace(extraction, extraction + '\n' + archive);
        const movedBeforeExtraction = step.replace(executable, '# moved executable check').replace(extraction, executable + '\n' + extraction);
        const movedAfterExecution = step.replace(executable, '# moved executable check').replace(execution, execution + '\n' + executable);
        for (const invalid of [step.replace(archive, '# removed archive check'),
            step.replace(executable, '# removed executable check'), step.replace(archive, '# ' + archive),
            step.replace(executable, '# ' + executable), movedAfterExtraction, movedBeforeExtraction, movedAfterExecution]) {
            assert.match(invalid, /Ripgrep archive checksum mismatch/u);
            assert.match(invalid, /Ripgrep executable checksum mismatch/u);
            assert.throws(() => assertRipgrepVerificationOrder(invalid, platform));
        }
    }
});

function assertSupportedSmokeMatrix(raw: string, workflowProfile: string, label: string): void {
    const jobBlock = getWorkflowJobBlock(raw, 'smoke');
    assert.ok(jobBlock.includes("matrix: ${{ fromJSON(needs.authorize.outputs.selection).jobs['smoke'].matrix }}"));
    const selector = require(path.join(getRepoRoot(), 'scripts/manual-workflow-authorization.cjs')) as {
        AUTHORIZATION_PHRASE: string;
        selectManualWorkflow(env: Record<string, string>): {
            jobs: Record<string, { matrix: { include: Array<{ os: string; 'node-version': string }> } }>;
        };
    };
    // Pure registry inspection; these synthetic inputs never launch a workflow.
    const full = selector.selectManualWorkflow({ MANUAL_WORKFLOW: workflowProfile, GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REPOSITORY: 'fixture/contract', MANUAL_REPOSITORY: 'fixture/contract',
        GITHUB_SHA: 'a'.repeat(40), MANUAL_COMMIT: 'a'.repeat(40), MANUAL_AUTHORIZATION: selector.AUTHORIZATION_PHRASE,
        MANUAL_JOB: 'all', MANUAL_OS: 'all', MANUAL_RUNTIME: 'all' });
    assert.deepEqual(
        full.jobs.smoke.matrix.include,
        [
            { os: 'ubuntu-latest', 'node-version': '22.13.0' }, { os: 'ubuntu-latest', 'node-version': '24' },
            { os: 'windows-latest', 'node-version': '22.13.0' }, { os: 'windows-latest', 'node-version': '24' },
            { os: 'macos-latest', 'node-version': '22.13.0' }, { os: 'macos-latest', 'node-version': '24' }
        ],
        `${label} must preserve all six supported OS/Node combinations`
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
    assertSupportedSmokeMatrix(raw, 'ci', 'CI smoke job');
});

test('manual smoke workflow covers supported OS and Node combinations', () => {
    const raw = getRawContent(loadManualSmokeWorkflow());
    const smokeJob = getWorkflowJobBlock(raw, 'smoke');

    assert.match(raw, /^\s+smoke:/m, 'Manual smoke workflow must define a smoke job');
    assert.match(smokeJob, /name:\s*Smoke \/ \$\{\{\s*matrix\.os\s*}} \/ Node \$\{\{\s*matrix\.node-version\s*}}/);
    assertSupportedSmokeMatrix(raw, 'smoke-schedule', 'Manual smoke job');
});

test('lifecycle smoke commits the prebuilt bundle atop the checked-out commit', () => {
    const workflows = [
        ['CI', getWorkflowJobBlock(getRawContent(loadCiWorkflow()), 'smoke')],
        ['Manual smoke', getWorkflowJobBlock(getRawContent(loadManualSmokeWorkflow()), 'smoke')]
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
    assertSmokeUpload(getWorkflowJobBlock(raw, 'smoke'));
});

test('smoke upload assertions reject a pin or condition present only in another step', () => {
    const job = getWorkflowJobBlock(getRawContent(loadCiWorkflow()), 'smoke');
    const step = getWorkflowStepBlock(job, 'Upload smoke failure evidence');
    const decoy = step.replace('Upload smoke failure evidence', 'Unrelated upload');
    for (const [before, after, message] of [
        ['043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', 'v7.0.1', /immutable/],
        ['if: failure()', 'if: always()', /run on failure/]
    ] as const) {
        const invalidJob = job.replace(step, step.replace(before, after));
        assert.throws(() => assertSmokeUpload(`${invalidJob}\n${decoy}`), message);
    }
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

for (const [label, load] of [['CI', loadCiWorkflow], ['Manual smoke', loadManualSmokeWorkflow]] as const) {
    test(label + ' preserves scoped lifecycle output, failure snapshots and upload contracts', () => {
        assertSmokeForensics(getWorkflowJobBlock(getRawContent(load()), 'smoke'));
    });

    test(label + ' forensic assertions reject disabled or removed diagnostics despite neighboring decoys', () => {
        const job = getWorkflowJobBlock(getRawContent(load()), 'smoke');
        const collection = getWorkflowStepBlock(job, 'Collect smoke failure evidence');
        const upload = getWorkflowStepBlock(job, 'Upload smoke failure evidence');
        const lifecycle = getWorkflowStepBlock(job, 'Lifecycle smoke (cross-platform E2E install → update → uninstall)');
        const decoys = '\n' + collection.replace('Collect smoke failure evidence', 'Unrelated collection') +
            '\n' + upload.replace('Upload smoke failure evidence', 'Unrelated upload');
        for (const [step, before, after] of [
            [collection, 'Collect smoke failure evidence', 'Removed collection'],
            [collection, 'if: failure()', 'if: always()'],
            [collection, 'for log in "$HOME"/.npm/_logs/*.log; do', '# removed npm log loop'],
            [collection, 'SMOKE_DIR="${{ steps.lifecycle-smoke.outputs.smoke_dir }}"', '# removed output forwarding'],
            [collection, 'cp -r "$SMOKE_DIR/garda-agent-orchestrator/runtime" smoke-failure-evidence/smoke-runtime',
                '# removed runtime capture'],
            [collection, 'cp -r "$SMOKE_DIR/garda-agent-orchestrator/live/config" smoke-failure-evidence/smoke-config',
                '# removed configuration capture'],
            [collection, '} > smoke-failure-evidence/runner-env.txt', '} > unrelated-environment.txt'],
            [upload, 'Upload smoke failure evidence', 'Removed upload'],
            [upload, 'if: failure()', 'if: always()'],
            [upload, '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', 'v7.0.1'],
            [upload, 'name: smoke-failure-evidence-${{ matrix.os }}-node${{ matrix.node-version }}', 'name: unqualified-evidence'],
            [upload, 'path: smoke-failure-evidence/', 'path: unrelated/'],
            [upload, 'retention-days: 15', 'retention-days: 999'],
            [lifecycle, 'id: lifecycle-smoke', '# removed lifecycle id'],
            [lifecycle, 'echo "smoke_dir=$SMOKE_DIR" >> "$GITHUB_OUTPUT"', '# removed lifecycle output']
        ] as const) {
            const mutated = step.replace(before, after);
            assert.notEqual(mutated, step, 'Negative fixture must alter the selected statement');
            assert.throws(() => assertSmokeForensics(job.replace(step, mutated) + decoys));
        }
    });
}
