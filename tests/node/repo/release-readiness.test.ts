import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    formatReleaseReadinessResult,
    parseCandidateReadinessArgs,
    EMBEDDED_BUNDLE_PARITY_ITEMS,
    RELEASE_VALIDATION_COMMANDS,
    RELEASE_VALIDATION_COMMAND_HANDLERS,
    resolveReleaseValidationCommand,
    runReleaseValidationCli,
    validateReleaseReadiness
} from '../../../scripts/node-foundation/validate-release';

import type { CandidateReadinessRequest, GithubEvidenceFetcher } from '../../../scripts/node-foundation/release-validation/candidate-readiness';

const RELEASE_BLOCKERS = Object.freeze([
    'T-385',
    'T-371',
    'T-328',
    'T-329',
    'T-330',
    'T-331',
    'T-332',
    'T-333',
    'T-334',
    'T-319',
    'T-320',
    'T-455',
    'T-456',
    'T-321',
    'T-326',
    'T-270',
    'T-290',
    'T-309',
    'T-238'
]);

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

function initializeGitIndex(repoRoot: string): void {
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['add', '.']);
}

function commitFixture(repoRoot: string, message: string): void {
    runGit(repoRoot, ['config', 'user.name', 'Garda Release Fixture']);
    runGit(repoRoot, ['config', 'user.email', 'garda-release-fixture@example.invalid']);
    runGit(repoRoot, ['commit', '--no-gpg-sign', '-m', message]);
}

function buildPackageJson(): string {
    return JSON.stringify({
        name: 'garda-agent-orchestrator',
        version: '1.1.0',
        scripts: {
            'validate:version-parity': 'node scripts/node-foundation/build-scripts.cjs validate-release.js',
            'validate:embedded-bundle-parity': 'node scripts/node-foundation/build-scripts.cjs validate-release.js embedded-bundle-parity',
            'validate:clean-worktree': 'node scripts/node-foundation/build-scripts.cjs validate-release.js clean-worktree',
            'validate:release-readiness': 'node scripts/node-foundation/build-scripts.cjs validate-release.js release-readiness',
            'validate:package-surface': 'node scripts/node-foundation/build-scripts.cjs validate-release.js package-surface',
            'test:release-smoke': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/core/task-ids.test.ts tests/node/gate-runtime/task-events-append.test.ts tests/node/gates/next-step/next-step-startup-routing.test.ts tests/node/validators/status.test.ts tests/node/validators/why-blocked.test.ts tests/node/validators/doctor-formatting.test.ts',
            lint: 'eslint "src/**/*.ts" "tests/node/**/*.ts" "scripts/node-foundation/**/*.ts"',
            coverage: 'c8 npm test',
            'coverage:fast': 'c8 npm run test:fast',
            'audit:prod': 'npm audit --omit=dev',
            'typecheck:unused': 'tsc -p tsconfig.node-foundation.json --noEmit --pretty false --noUnusedLocals --noUnusedParameters',
            quality: 'npm run typecheck && npm run typecheck:unused && npm run lint && npm run coverage && npm run audit:prod',
            'quality:fast': 'npm run typecheck && npm run typecheck:unused && npm run lint && npm run coverage:fast && npm run audit:prod',
            'validate:release': 'npm run validate:clean-worktree && npm run validate:version-parity && npm run build && npm run validate:embedded-bundle-parity && npm run quality && npm run test:packaging && npm run validate:clean-worktree',
            'validate:release:fast': 'npm run validate:clean-worktree && npm run validate:version-parity && npm run build && npm run validate:embedded-bundle-parity && npm run quality:fast && npm run test:packaging && npm run validate:clean-worktree',
            'release:preflight': 'npm run validate:release-readiness && npm run test:release-smoke && npm run validate:release && npm run validate:package-surface',
            'archive:source': 'node scripts/node-foundation/build-scripts.cjs archive-release.js source',
            'archive:evidence': 'node scripts/node-foundation/build-scripts.cjs archive-release.js evidence',
            'sbom:generate': 'cyclonedx-npm --output-file sbom.cdx.json --spec-version 1.5 --output-reproducible',
            prepack: 'npm run validate:clean-worktree && npm run build:publish-runtime && npm run validate:clean-worktree && node scripts/package-legacy-entrypoint-compat.cjs create',
            'test:unit': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/core',
            'test:gates': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates',
            'test:cli': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/cli',
            'test:lifecycle': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/lifecycle',
            'test:bin': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/bin',
            'test:packaging': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/packaging/pack-smoke.test.ts tests/node/packaging/package-surface.test.ts',
            'test:sharded': 'node scripts/node-foundation/build-scripts.cjs test.js --garda-shards 2 --garda-shard-concurrency 2 tests/node/core tests/node/gate-runtime tests/node/schemas tests/node/validators tests/node/repo tests/node/reports tests/node/compat tests/node/policy tests/node/runtime tests/node/gates tests/node/cli tests/node/lifecycle tests/node/bin tests/node/materialization',
            'test:full': 'node scripts/node-foundation/build-scripts.cjs build.js node-foundation && node scripts/node-foundation/build-scripts.cjs test.js tests/node/core tests/node/gate-runtime tests/node/schemas tests/node/validators tests/node/repo tests/node/reports tests/node/compat tests/node/policy tests/node/runtime tests/node/gates tests/node/cli tests/node/lifecycle tests/node/bin tests/node/materialization',
            'test:fast': 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/core'
        },
        devDependencies: {
            '@cyclonedx/cyclonedx-npm': '6.0.1'
        },
        c8: {
            all: true,
            reporter: ['text', 'lcov'],
            include: ['.node-build/src/**/*.js', '.node-build/scripts/node-foundation/**/*.js', 'src/**/*.ts', 'scripts/**/*.ts', 'scripts/**/*.cjs', 'bin/**/*.js'],
            exclude: ['coverage/**', 'dist/**', '.node-build/tests/**', '.scripts-build/**', 'garda-agent-orchestrator/**', 'node_modules/**', 'tests/**'],
            excludeAfterRemap: true
        },
        files: [
            'bin',
            'dist',
            'template',
            'package.json',
            'MANIFEST.md',
            'SECURITY.md',
            'docs/assets/garda-github-social-preview.png',
            'README.md',
            'HOW_TO.md',
            'CHANGELOG.md',
            'docs/branch-protection.md',
            'docs/architecture.md',
            'docs/cli-reference.md',
            'docs/compatibility-matrix.md',
            'docs/configuration.md',
            'docs/control-plane-isolation.md',
            'docs/database/sqlite-persistence.md',
            'docs/database/sqlite-query-adoption-evidence.md',
            'docs/findings-contracts.md',
            'docs/node-runtime-contract.md',
            'docs/node-platform-foundation.md',
            'docs/operator-consistency-runbook.md',
            'docs/orchestrator-work-and-isolation.md',
            'docs/providers.md',
            'docs/release-readiness.md',
            'docs/secret-scanning.md',
            'docs/sbom.md',
            'docs/threat-model.md',
            'docs/work-example.md',
            'VERSION'
        ]
    }, null, 2);
}

function updatePackageScripts(repoRoot: string, update: (scripts: Record<string, string>) => void): void {
    const packagePath = path.join(repoRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
        scripts: Record<string, string>;
    };
    update(packageJson.scripts);
    writeFile(packagePath, JSON.stringify(packageJson, null, 2));
}

function buildReleaseChecklist(openItem?: string): string {
    const releaseBlockers = RELEASE_BLOCKERS.map((taskId) => {
        const status = taskId === openItem ? ' ' : 'x';
        return `- [${status}] ${taskId} fixture release blocker`;
    });
    const trustedPublishItems = [
        '- [x] Explicit manual Publish selects validate or stage-publish with `security_run_id`.',
        '- [x] Trusted Publishing workflow uses `publish.yml`.',
        '- [x] GitHub Environment `npm-release` gates publish.',
        '- [x] GitHub Environment `npm-release` is release-tag restricted.',
        '- [x] npm Trusted Publisher settings use `Shubchynskyi` / `garda-agent-orchestrator` / `publish.yml`.',
        '- [x] Allowed action is `npm stage publish`.',
        '- [x] npm-side staged approval with maintainer 2FA is documented.',
        '- [x] Publishing access moves to Require two-factor authentication and disallow tokens after verification.',
        '- [x] Post-publish verification runs npx --yes garda-agent-orchestrator@1.1.0 --version.'
    ];
    return [
        '# Release Readiness',
        '',
        'This tracked checklist is the release-cut source of truth for readiness.',
        '',
        '## 1.1.0',
        '',
        releaseBlockers.concat(trustedPublishItems).join('\n'),
        '',
        '## 1.2.0'
    ].join('\n');
}

function buildPackageSurfaceBaseline(): string {
    const baseline = JSON.parse(fs.readFileSync(
        path.join(process.cwd(), 'config', 'release-package-surface-baseline.json'),
        'utf8'
    )) as { package: { version: string } };
    baseline.package.version = '1.1.0';
    return JSON.stringify(baseline, null, 2);
}

interface BuildCiWorkflowOptions {
    includeNodeVersionInJobs?: boolean;
    smokeSteps?: string;
}

function buildCiWorkflow(options: BuildCiWorkflowOptions = {}): string {
    const includeNode = options.includeNodeVersionInJobs !== false;
    const smokeSteps = options.smokeSteps || '    - run: $CLI setup\n    - run: $CLI update git\n    - run: $CLI doctor\n    - run: $CLI uninstall';

    return [
        'validate-release:',
        '  name: Release Validation / ${{ matrix.os }} / Node ${{ matrix.node-version }}',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '      os:',
        '        - ubuntu-latest',
        '        - windows-latest',
        '  steps:',
        '    - run: npm run validate:release:fast',
        'test-unit:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '  steps:',
        '    - run: npm run test:unit',
        'test-gates:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '  steps:',
        '    - run: npm run test:gates',
        '      env:',
        '        GARDA_NODE_FOUNDATION_TEST_SHARDS: 2',
        'test-cli:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '  steps:',
        '    - run: npm run test:cli',
        '      env:',
        '        GARDA_NODE_FOUNDATION_TEST_SHARDS: 2',
        'test-lifecycle:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '  steps:',
        '    - run: npm run test:lifecycle',
        'test-bin:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '  steps:',
        '    - run: npm run test:bin',
        'smoke:',
        '  strategy:',
        '    matrix:',
        includeNode ? '      node-version:\n        - \'22.13.0\'\n        - \'24\'' : '',
        '      os:',
        '        - ubuntu-latest',
        '        - windows-latest',
        '        - macos-latest',
        '  steps:',
        smokeSteps
    ].filter(Boolean).join('\n');
}

function buildSecurityWorkflow(): string {
    return fs.readFileSync(path.join(process.cwd(), '.github/workflows/security.yml'), 'utf8');
}

function buildSecretScanningWorkflow(
    transformJob: (job: string) => string = (job) => job
): string {
    const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/secret-scanning.yml'), 'utf8');
    const start = workflow.indexOf('\n  gitleaks:\n') + 1;
    assert.ok(start > 0, 'The reviewed workflow contains its top-level scanner job');
    const job = workflow.slice(start).replace(/^ {2}/gmu, '');
    return workflow.slice(0, start) + transformJob(job).split('\n')
        .map((line) => line ? `  ${line}` : '').join('\n');
}

function buildSbomWorkflow(): string {
    return fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'sbom.yml'), 'utf8');
}

function buildPublishWorkflow(): string {
    return fs.readFileSync(path.join(process.cwd(), '.github/workflows/publish.yml'), 'utf8');
}

function buildBranchProtectionDoc(): string {
    return [
        '# Branch Protection',
        '',
        '## Release Security Required Checks',
        '',
        '| Check | Label | Branch-protection guidance | Rationale |',
        '|---|---|---|---|',
        '| `CI` / release validation matrix | `blocking` | Required | Fixture release validation. |',
        '| `Security / npm audit` | `blocking` | Required | Fixture dependency audit. |',
        '| `Secret Scanning / Gitleaks` | `blocking` | Required | Fixture secret scanning. |',
        '| `Security / OSV Vulnerability Scan` | `informational` | Optional required check | Fixture OSV scan. |',
        '| `SBOM / Generate SBOM` | `informational` | Optional required check | Fixture SBOM artifact. |',
        '',
        '## GitHub Action pinning decision',
        '',
        'Actions remain version-tag pinned and intentionally not SHA-pinned at this time. This does not replace future provenance or release-signing work.',
        '',
        '## Update-source policy reporting',
        '',
        '- NPM_REGISTRY_INTEGRITY_RECORDED',
        '- TRUSTED_GIT_NO_RELEASE_SIGNATURE',
        '- TRUST_OVERRIDE_UNVERIFIED'
    ].join('\n');
}

function createReadinessFixture(openChecklistItem?: string): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-release-readiness-'));

    writeFile(path.join(repoRoot, 'package.json'), buildPackageJson());
    writeFile(path.join(repoRoot, 'package-lock.json'), JSON.stringify({
        name: 'garda-agent-orchestrator',
        version: '1.1.0',
        lockfileVersion: 3,
        packages: {
            '': {
                version: '1.1.0',
                devDependencies: { '@cyclonedx/cyclonedx-npm': '6.0.1' }
            },
            'node_modules/@cyclonedx/cyclonedx-npm': {
                version: '6.0.1',
                integrity: 'sha512-/aU3bBC6qP6cV/qQ5SfUSygE/+2hQhwgg6sJML31/gZ96NyMvIUuwdk637H4z+LS/NryRT2kjR2wtD0qBEVVHQ=='
            }
        }
    }, null, 2));
    writeFile(path.join(repoRoot, 'config', 'release-package-surface-baseline.json'), buildPackageSurfaceBaseline());
    writeFile(path.join(repoRoot, 'TASK.md'), '# Local task queue is not release truth.\n');
    writeFile(path.join(repoRoot, 'SECURITY.md'), '# Security\n');
    writeFile(
        path.join(repoRoot, 'MANIFEST.md'),
        [
            '- package.json',
            '- SECURITY.md',
            '- README.md',
            '- HOW_TO.md',
            '- CHANGELOG.md',
            '- docs/assets/garda-github-social-preview.png',
            '- docs/architecture.md',
            '- docs/branch-protection.md',
            '- docs/cli-reference.md',
            '- docs/compatibility-matrix.md',
            '- docs/configuration.md',
            '- docs/control-plane-isolation.md',
            '- docs/database/sqlite-persistence.md',
            '- docs/database/sqlite-query-adoption-evidence.md',
            '- docs/findings-contracts.md',
            '- docs/node-platform-foundation.md',
            '- docs/node-runtime-contract.md',
            '- docs/operator-consistency-runbook.md',
            '- docs/orchestrator-work-and-isolation.md',
            '- docs/providers.md',
            '- docs/release-readiness.md',
            '- docs/work-example.md',
            '- docs/threat-model.md',
            '- docs/secret-scanning.md',
            '- docs/sbom.md'
        ].join('\n')
    );
    writeFile(path.join(repoRoot, 'VERSION'), '1.1.0\n');
    writeFile(path.join(repoRoot, 'README.md'), '# Readme\n');
    writeFile(path.join(repoRoot, 'HOW_TO.md'), '# How To\n');
    writeFile(
        path.join(repoRoot, 'CHANGELOG.md'),
        '# Changelog\n\n## 1.1.0\n\n- Fixture release notes.\n'
    );
    writeFile(path.join(repoRoot, 'docs', 'assets', 'garda-github-social-preview.png'), 'fixture image\n');
    writeFile(path.join(repoRoot, 'docs', 'architecture.md'), '# Architecture\n');
    writeFile(path.join(repoRoot, 'docs', 'branch-protection.md'), buildBranchProtectionDoc());
    writeFile(path.join(repoRoot, 'docs', 'compatibility-matrix.md'), '# Compatibility Matrix\n');
    writeFile(path.join(repoRoot, 'docs', 'configuration.md'), '# Configuration\n');
    writeFile(path.join(repoRoot, 'docs', 'control-plane-isolation.md'), '# Control Plane Isolation\n');
    writeFile(path.join(repoRoot, 'docs', 'database', 'sqlite-persistence.md'), '# SQLite Persistence\n');
    writeFile(path.join(repoRoot, 'docs', 'database', 'sqlite-query-adoption-evidence.md'), '# SQLite Query Adoption Evidence\n');
    writeFile(path.join(repoRoot, 'docs', 'findings-contracts.md'), '# Findings Contracts\n');
    writeFile(path.join(repoRoot, 'docs', 'node-runtime-contract.md'), '# Node Runtime Contract\n');
    writeFile(path.join(repoRoot, 'docs', 'orchestrator-work-and-isolation.md'), '# Orchestrator Work And Isolation\n');
    writeFile(path.join(repoRoot, 'docs', 'providers.md'), '# Providers\n');
    writeFile(path.join(repoRoot, 'docs', 'secret-scanning.md'), '# Secret Scanning\n');
    writeFile(path.join(repoRoot, 'docs', 'work-example.md'), '# Work Example\n');
    writeFile(path.join(repoRoot, 'docs', 'threat-model.md'), '# Threat Model\n');
    writeFile(path.join(repoRoot, 'docs', 'sbom.md'), '# SBOM\n');
    writeFile(path.join(repoRoot, 'docs', 'release-readiness.md'), buildReleaseChecklist(openChecklistItem));
    writeFile(path.join(repoRoot, 'docs', 'operator-consistency-runbook.md'), '# Runbook\n');
    writeFile(
        path.join(repoRoot, 'docs', 'cli-reference.md'),
        [
            'garda doctor',
            'garda gate validate-manifest',
            'runtime/task-events/<task-id>.jsonl'
        ].join('\n')
    );
    writeFile(
        path.join(repoRoot, 'docs', 'run-methods.md'),
        [
            'npm run validate:release',
            'node .\\bin\\garda.js gate validate-manifest --manifest-path MANIFEST.md',
            '.github/workflows/publish.yml',
            'npm-release',
            'selected deployment branches/tags',
            'v*',
            'Trusted Publisher',
            'Shubchynskyi',
            'publish.yml',
            'npm staged publishing approval',
            'Require two-factor authentication and disallow tokens',
            'npm stage publish'
        ].join('\n')
    );
    writeFile(
        path.join(repoRoot, 'docs', 'node-platform-foundation.md'),
        [
            '### npm run validate:release',
            'The cross-platform lifecycle smoke proves update runtime behavior.',
            'Full-suite optimization compatibility guardrails',
            'GARDA_NODE_FOUNDATION_TEST_SHARDS',
            'Manual npm staged publishing',
            'workflow_dispatch',
            'stage-publish',
            '.github/workflows/publish.yml',
            'npm Trusted Publishing',
            'npm staged approval',
            'v*',
            'OIDC',
            'npm stage publish'
        ].join('\n')
    );
    writeFile(
        path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
        fs.readFileSync(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
    );
    writeFile(path.join(repoRoot, 'scripts/manual-workflow-authorization.cjs'),
        fs.readFileSync(path.join(process.cwd(), 'scripts/manual-workflow-authorization.cjs'), 'utf8'));
    writeFile(path.join(repoRoot, '.github', 'workflows', 'security.yml'), buildSecurityWorkflow());
    writeFile(path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'), buildSecretScanningWorkflow());
    writeFile(path.join(repoRoot, '.github', 'workflows', 'sbom.yml'), buildSbomWorkflow());
    writeFile(path.join(repoRoot, '.github', 'workflows', 'publish.yml'), buildPublishWorkflow());

    initializeGitIndex(repoRoot);

    return repoRoot;
}

function pinReadinessFixtureActions(repoRoot: string): void {
    // Feed readiness from the validator's reviewed catalog, so a future pin
    // update fails this test if readiness normalization is left behind.
    const validatorSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'validate-workflow-references.cjs'), 'utf8');
    const catalogPins = new Map<string, { sha: string; version: string }>();
    for (const match of validatorSource.matchAll(/\['([^']+)',\s*\{\s*sha:\s*'([0-9a-f]{40})',\s*version:\s*'(v\d+\.\d+\.\d+)'/gu)) {
        catalogPins.set(match[1], { sha: match[2], version: match[3] });
    }
    assert.equal(catalogPins.size, 4, 'readiness fixture must reflect the complete reviewed workflow pin catalog');
    const reviewedPins = [
        ['actions/checkout', 'v7.0.0'],
        ['actions/setup-node', 'v6'],
        ['actions/upload-artifact', 'v7.0.1'],
        ['google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml', 'v2.3.0']
    ] as const;
    for (const fileName of ['security.yml', 'secret-scanning.yml', 'sbom.yml', 'publish.yml']) {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', fileName);
        let workflow = fs.readFileSync(workflowPath, 'utf8');
        for (const [identity, readinessVersion] of reviewedPins) {
            const catalogPin = catalogPins.get(identity);
            assert.ok(catalogPin, `missing reviewed workflow pin: ${identity}`);
            workflow = workflow.replaceAll(
                `${identity}@${readinessVersion}`,
                `${identity}@${catalogPin.sha} # ${catalogPin.version}`
            );
        }
        writeFile(workflowPath, workflow);
    }
}

test('release readiness passes when package, CI, docs, security, and checklist contracts are present', () => {
    const repoRoot = createReadinessFixture();
    try {
        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, true, output);
        assert.deepEqual(result.openReleaseChecklistItems, []);
        assert.match(output, /RELEASE_READINESS_OK/);
        assert.match(output, /ReleaseNotesInput:/);
        assert.match(output, /Validation command: npm run release:preflight/);
        assert.match(output, /Short smoke: test:release-smoke exercises task id parsing/);
        assert.match(output, /Package smoke: npm run test:packaging remains an explicit validate:release step/);
        assert.match(output, /Readiness alignment:/);
        assert.match(output, /Unused-symbol enforcement: quality includes typecheck:unused/);
        assert.match(output, /security-ci: existing release-security CI checks are present and labelled blocking or informational/);
        assert.match(output, /trusted-publish-workflow: npm Trusted Publishing workflow is manually authorized/);
        assert.match(output, /trusted-publish-docs: release docs document the manually authorized npm Trusted Publishing operator path/);
        assert.match(output, /Release-security baseline: readiness labels npm audit and gitleaks as blocking/);
        assert.match(output, /Trusted Publishing path: explicitly dispatch/);
        assert.doesNotMatch(output, /Security\/audit proof:/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

for (const [name, before, after] of [
    ['automatic tag push', '  workflow_dispatch:\n    inputs:', '  push:\n    inputs:'],
    ['implicit staging', "jobs['stage-publish'].enabled", 'jobs.validate.enabled'],
    ['missing authorization dependency', '    needs: [authorize]\n', '    needs: []\n'],
    ['foreign checkout ref', '          ref: ${{ github.sha }}', '          ref: dev'],
    ['masked validation history', 'node scripts/release-publish-history-evidence.cjs validate',
        'node scripts/release-publish-history-evidence.cjs validate || true'],
    ['masked staging history', 'node scripts/release-publish-history-evidence.cjs stage-publish',
        'node scripts/release-publish-history-evidence.cjs stage-publish || true'],
    ['missing candidate Security attestation', 'node scripts/release-security-evidence.cjs attest',
        'echo scripts/release-security-evidence.cjs attest'],
    ['missing live Security re-verification', 'node scripts/release-security-evidence.cjs verify',
        'echo scripts/release-security-evidence.cjs verify'],
    ['cancelling same-tag serialization', '  cancel-in-progress: false', '  cancel-in-progress: true']
] as const) {
    test(`release readiness rejects manual Publish ${name}`, () => {
        const root = createReadinessFixture();
        try {
            const file = path.join(root, '.github/workflows/publish.yml');
            const original = fs.readFileSync(file, 'utf8');
            assert.ok(original.includes(before), 'negative fixture must change the intended contract');
            writeFile(file, original.replace(before, after));
            const result = validateReleaseReadiness(root);
            assert.equal(result.checks.find(check => check.area === 'trusted-publish-workflow')?.passed, false);
            assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
}

test('release readiness accepts the reviewed SHA-pinned Actions across security and publish workflows', () => {
    const repoRoot = createReadinessFixture();
    try {
        pinReadinessFixtureActions(repoRoot);
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, true, formatReleaseReadinessResult(result));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness accepts quoted uses keys and references for reviewed pins', () => {
    const repoRoot = createReadinessFixture();
    try {
        pinReadinessFixtureActions(repoRoot);
        for (const name of ['secret-scanning.yml', 'sbom.yml', 'publish.yml']) {
            const workflowPath = path.join(repoRoot, '.github', 'workflows', name);
            const original = fs.readFileSync(workflowPath, 'utf8');
            const quoted = original.replace(
                '    - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
                '    - "uses": "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0" # v7.0.0'
            );
            assert.notEqual(quoted, original);
            writeFile(workflowPath, quoted);
        }
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, true, formatReleaseReadinessResult(result));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness accepts CRLF reviewed CI, Security, auxiliary and Publish workflows', () => {
    const repoRoot = createReadinessFixture();
    try {
        for (const name of ['ci.yml', 'security.yml', 'secret-scanning.yml', 'sbom.yml', 'publish.yml']) {
            const workflowPath = path.join(repoRoot, '.github', 'workflows', name);
            const original = fs.readFileSync(workflowPath, 'utf8');
            const crlf = original.replace(/\r?\n/gu, '\r\n');
            assert.notEqual(crlf, original);
            writeFile(workflowPath, crlf);
        }
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, true, formatReleaseReadinessResult(result));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects manual Security source drift without a legacy marker fallback', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github/workflows/security.yml');
        const original = fs.readFileSync(workflowPath, 'utf8');
        const anchor = '          npm audit --package-lock=true';
        assert.ok(original.includes(anchor));
        assert.equal(validateReleaseReadiness(repoRoot).passed, true);
        const changed = original.replace(anchor,
            "          # ${{ fromJSON('\"\\nexit 0\\n\"') }}\n" +
            '          npm audit --audit-level=high --no-fund\n' + anchor);
        assert.notEqual(changed, original);
        const verifier = require(path.join(process.cwd(), 'scripts/release-security-evidence.cjs')) as {
            assertSecurityWorkflow(content: string): void;
        };
        assert.throws(() => verifier.assertSecurityWorkflow(changed), /differs from the reviewed/);
        writeFile(workflowPath, changed);
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.equal(result.checks.find(check => check.area === 'security-ci')?.passed, false);
        const output = formatReleaseReadinessResult(result);
        assert.match(output, /blocking: security\.yml npm audit high-severity gate present=false/);
        assert.match(output, /informational: security\.yml OSV lockfile scan present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects executable scalar source drift in reviewed Publish', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github/workflows/publish.yml');
        const original = fs.readFileSync(workflowPath, 'utf8');
        const anchor = '          set -euo pipefail\n';
        assert.ok(original.includes(anchor));
        assert.equal(validateReleaseReadiness(repoRoot).passed, true);
        for (const inserted of [
            "          # ${{ fromJSON('\"\\nexit 0\\n\"') }}\n",
            '          # An unreviewed scalar comment\n',
            '\n',
            '          \n'
        ]) {
            const changed = original.replace(anchor, inserted + anchor);
            assert.notEqual(changed, original);
            writeFile(workflowPath, changed);
            const result = validateReleaseReadiness(repoRoot);
            assert.equal(result.passed, false);
            assert.ok(result.violations.some(violation => violation.startsWith('trusted-publish-workflow:')));
        }
        writeFile(workflowPath, original.trimEnd());
        assert.ok(validateReleaseReadiness(repoRoot).violations.some(violation => violation.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness ignores a reviewed-looking uses line inside a block scalar', () => {
    const repoRoot = createReadinessFixture();
    try {
        pinReadinessFixtureActions(repoRoot);
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'security.yml');
        const pinnedOsV = 'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@b77c075a1235514558f0eb88dbd31e22c45e0cd2 # v2.3.0';
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8')
                .replace(`  uses: ${pinnedOsV}\n`, '')
                .replace('      --lockfile=package-lock.json', `      uses: ${pinnedOsV}\n      --lockfile=package-lock.json`)
        );
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.match(formatReleaseReadinessResult(result), /informational: security\.yml OSV lockfile scan present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness ignores reviewed-looking uses text in multiline quoted scalars', () => {
    const scanner = require(path.join(process.cwd(), 'scripts', 'validate-workflow-references.cjs')) as {
        scanWorkflowUses: (content: string) => Array<{ reference: string }>;
    };
    for (const quote of ['"', "'"]) {
        const repoRoot = createReadinessFixture();
        try {
            pinReadinessFixtureActions(repoRoot);
            const workflowPath = path.join(repoRoot, '.github', 'workflows', 'security.yml');
            const pinnedOsV = 'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@b77c075a1235514558f0eb88dbd31e22c45e0cd2 # v2.3.0';
            const workflow = fs.readFileSync(workflowPath, 'utf8').replace(
                `  uses: ${pinnedOsV}`,
                `  name: ${quote}OSV scan\n  uses: ${pinnedOsV}\n  ${quote}`
            );
            writeFile(workflowPath, workflow);
            assert.equal(scanner.scanWorkflowUses(workflow).some((use) => use.reference.includes('osv-scanner-reusable.yml')), false);
            const result = validateReleaseReadiness(repoRoot);
            assert.equal(result.passed, false);
            assert.match(formatReleaseReadinessResult(result), /informational: security\.yml OSV lockfile scan present=false/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    }
});

test('release readiness rejects a forged SHA or version comment in a pinned Action', () => {
    for (const replacement of [
        'actions/checkout@0c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
        'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.1'
    ]) {
        const repoRoot = createReadinessFixture();
        try {
            pinReadinessFixtureActions(repoRoot);
            const workflowPath = path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml');
            writeFile(
                workflowPath,
                fs.readFileSync(workflowPath, 'utf8').replace(
                    'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
                    replacement
                )
            );
            const result = validateReleaseReadiness(repoRoot);
            assert.equal(result.passed, false);
            assert.match(formatReleaseReadinessResult(result), /blocking: secret-scanning\.yml gitleaks gate present=false/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    }
});

test('release readiness rejects the target tag even when it points at HEAD', () => {
    const repoRoot = createReadinessFixture();
    try {
        commitFixture(repoRoot, 'fixture release candidate');
        runGit(repoRoot, ['tag', 'v1.1.0']);

        const localPreTagResult = validateReleaseReadiness(repoRoot);
        const localPreTagOutput = formatReleaseReadinessResult(localPreTagResult);
        assert.equal(localPreTagResult.passed, false);
        assert.match(localPreTagOutput, /release readiness requires an unassigned version/u);

        writeFile(path.join(repoRoot, 'README.md'), '# Readme\n\nLater release candidate commit.\n');
        runGit(repoRoot, ['add', 'README.md']);
        commitFixture(repoRoot, 'later release candidate');

        const reusedVersionResult = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(reusedVersionResult);
        assert.equal(reusedVersionResult.passed, false);
        assert.match(output, /release-tag: the target version is not assigned to another local Git commit/u);
        assert.match(output, /Local release tag v1\.1\.0 already points at/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when CHANGELOG does not start with the target version', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, 'CHANGELOG.md'),
            '# Changelog\n\n## 1.2.0\n\n- Notes for a different version.\n\n## 1.1.0\n\n- Fixture release notes.\n'
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);
        assert.equal(result.passed, false);
        assert.match(output, /changelog: CHANGELOG starts with one populated target section and preserves released history/u);
        assert.match(output, /first release heading=1\.2\.0/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects rewritten history from the prior release tag', () => {
    const repoRoot = createReadinessFixture();
    try {
        const releasedHistory = '## 1.0.0\n\n- Released history.\n';
        writeFile(path.join(repoRoot, 'CHANGELOG.md'), `# Changelog\n\n${releasedHistory}`);
        runGit(repoRoot, ['add', 'CHANGELOG.md']);
        commitFixture(repoRoot, 'fixture prior release');
        runGit(repoRoot, ['tag', 'v1.0.0']);

        writeFile(
            path.join(repoRoot, 'CHANGELOG.md'),
            `# Changelog\n\n## 1.1.0\n\n- Fixture release notes.\n\n${releasedHistory}`
        );
        runGit(repoRoot, ['add', 'CHANGELOG.md']);
        const preservedResult = validateReleaseReadiness(repoRoot);
        assert.equal(preservedResult.passed, true, formatReleaseReadinessResult(preservedResult));

        writeFile(
            path.join(repoRoot, 'CHANGELOG.md'),
            '# Changelog\n\n## 1.1.0\n\n- Fixture release notes.\n\n## 1.0.0\n\n- Rewritten history.\n'
        );
        const rewrittenResult = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(rewrittenResult);
        assert.equal(rewrittenResult.passed, false);
        assert.match(output, /released history baseline=v1\.0\.0; preserved=false/u);

        writeFile(
            path.join(repoRoot, 'CHANGELOG.md'),
            '# Changelog\n\n## 1.1.0\n\n- Fixture release notes.\n'
        );
        const deletedHistoryResult = validateReleaseReadiness(repoRoot);
        const deletedHistoryOutput = formatReleaseReadinessResult(deletedHistoryResult);
        assert.equal(deletedHistoryResult.passed, false);
        assert.match(deletedHistoryOutput, /released history baseline=v1\.0\.0; preserved=false/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails on broken links in tracked Markdown documents', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(path.join(repoRoot, 'docs', 'broken-link.md'), '[missing](./not-present.md)\n');
        runGit(repoRoot, ['add', 'docs/broken-link.md']);

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);
        assert.equal(result.passed, false);
        assert.match(output, /documentation-links: tracked Markdown documents contain no broken repository-relative links/u);
        assert.match(output, /docs\/broken-link\.md -> \.\/not-present\.md \(missing target\)/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects Markdown destinations that escape through directory links', () => {
    const repoRoot = createReadinessFixture();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-release-link-outside-'));
    try {
        writeFile(path.join(outsideRoot, 'README.md'), '# Outside repository\n');
        fs.symlinkSync(
            outsideRoot,
            path.join(repoRoot, 'docs', 'external-target'),
            process.platform === 'win32' ? 'junction' : 'dir'
        );
        writeFile(
            path.join(repoRoot, 'docs', 'external-link.md'),
            '[external](./external-target/README.md)\n'
        );
        runGit(repoRoot, ['add', 'docs/external-link.md']);

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);
        assert.equal(result.passed, false);
        assert.match(output, /docs\/external-link\.md -> \.\/external-target\/README\.md \(outside repository\)/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('release readiness checks reference-style Markdown destinations', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, 'docs', 'broken-reference.md'),
            '[missing guide][guide]\n\n[guide]: ./not-present.md\n'
        );
        runGit(repoRoot, ['add', 'docs/broken-reference.md']);

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);
        assert.equal(result.passed, false);
        assert.match(output, /docs\/broken-reference\.md -> \.\/not-present\.md \(missing target\)/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects undefined shortcut references', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(path.join(repoRoot, 'docs', 'broken-shortcut.md'), '[missing guide]\n');
        runGit(repoRoot, ['add', 'docs/broken-shortcut.md']);

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);
        assert.equal(result.passed, false);
        assert.match(output, /docs\/broken-shortcut\.md -> \[missing guide\] \(undefined reference\)/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects missing Markdown heading anchors', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(path.join(repoRoot, 'docs', 'anchor-target.md'), '# Present Heading\n');
        writeFile(
            path.join(repoRoot, 'docs', 'broken-anchor.md'),
            '[missing heading](./anchor-target.md#missing-heading)\n'
        );
        runGit(repoRoot, ['add', 'docs/anchor-target.md', 'docs/broken-anchor.md']);

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);
        assert.equal(result.passed, false);
        assert.match(output, /docs\/broken-anchor\.md -> \.\/anchor-target\.md#missing-heading \(missing anchor\)/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness accepts spaced destinations, duplicate heading anchors, and explicit anchors', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, 'docs', 'space target.md'),
            '# Present Heading\n\n## Duplicate\n\n## Duplicate\n\n## `command` name\n\n<a id="manual-anchor"></a>\n'
        );
        writeFile(
            path.join(repoRoot, 'docs', 'valid-link-forms.md'),
            [
                '[angle destination](<./space target.md#present-heading>)',
                '[duplicate heading](<./space target.md#duplicate-1>)',
                '[explicit anchor][manual]',
                '<a href="./space%20target.md#present-heading">HTML link</a>',
                '`[non-link example](./not-present.md)`',
                '[inline code heading](./space%20target.md#command-name)',
                '',
                '[manual]: <./space target.md#manual-anchor>',
                ''
            ].join('\n')
        );
        runGit(repoRoot, ['add', 'docs/space target.md', 'docs/valid-link-forms.md']);

        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, true, formatReleaseReadinessResult(result));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when the package-surface baseline belongs to another version', () => {
    const repoRoot = createReadinessFixture();
    try {
        const baselinePath = path.join(repoRoot, 'config', 'release-package-surface-baseline.json');
        const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
            package: { version: string };
        };
        baseline.package.version = '1.0.0';
        writeFile(baselinePath, JSON.stringify(baseline, null, 2));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);
        assert.equal(result.passed, false);
        assert.match(output, /package-surface: release preflight scores the deterministic packed surface/u);
        assert.match(output, /baselineIdentityAligned=false/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails closed when the package-surface baseline is missing', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'config', 'release-package-surface-baseline.json'));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /package-surface: release preflight scores the deterministic packed surface/u);
        assert.match(output, /missing config\/release-package-surface-baseline\.json/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails closed when the package-surface baseline is malformed', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, 'config', 'release-package-surface-baseline.json'),
            JSON.stringify({ schemaVersion: 1, rationale: '' })
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /release-package-surface-baseline\.json\.schemaVersion must be 2/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when package-surface scoring is removed from release preflight', () => {
    const repoRoot = createReadinessFixture();
    try {
        updatePackageScripts(repoRoot, (scripts) => {
            scripts['release:preflight'] = 'npm run validate:release-readiness && npm run test:release-smoke && npm run validate:release';
        });

        const result = validateReleaseReadiness(repoRoot);

        assert.equal(result.passed, false);
        assert.ok(result.violations.some((violation) => violation.startsWith('package-surface:')));
        assert.ok(result.violations.some((violation) => violation.startsWith('release-gate:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish workflow is missing', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, '.github', 'workflows', 'publish.yml'));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish\.yml present=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when tagged publish jobs keep the local release tag ref', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replaceAll(
                '          git update-ref -d "refs/tags/${GITHUB_REF_NAME}"\n',
                ''
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /validate job removes its ephemeral local tag ref before release uniqueness proof=false/u);
        assert.match(output, /publish job removes its ephemeral local tag ref before release uniqueness proof=false/u);
        assert.ok(result.violations.some((violation) => violation.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when manual publish jobs omit their bounded retry guards', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replaceAll('node scripts/release-publish-history-evidence.cjs', 'echo history-not-checked')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /validate job binds bounded complete same-tag attempt history=false/u);
        assert.match(output, /publish job rejects started or uncertain staging history=false/u);
        assert.ok(result.violations.some((violation) => violation.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when tagged publish validation omits prior-run history', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                '          node scripts/release-publish-history-evidence.cjs validate\n',
                '          echo "workflow history omitted"\n'
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /validate job binds bounded complete same-tag attempt history=false/u);
        assert.ok(result.violations.some((violation) => violation.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects inert text containing every prior-run history marker', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                /[ ]{6}- name: Check publication history before validation\n[\s\S]+?(?=[ ]{6}- name: Require successful CI)/u,
                [
                    '      - name: Check publication history before validation',
                    '        shell: bash',
                    '        run: |',
                    '          : \'node scripts/release-publish-history-evidence.cjs validate\'',
                    '          git update-ref -d "refs/tags/${GITHUB_REF_NAME}"',
                    ''
                ].join('\n')
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /validate job binds bounded complete same-tag attempt history=false/u);
        assert.ok(result.violations.some((violation) => violation.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when workflow-run history permission is missing', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace('  actions: read\n', '')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish workflow has read-only access to provider workflow-run history=false/u);
        assert.ok(result.violations.some((violation) => violation.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when tagged publish jobs omit release-tag history', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replaceAll(
                '          fetch-depth: 0\n',
                '          fetch-depth: 1\n'
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish jobs fetch release-tag history for changelog preservation checks=false/u);
        assert.ok(result.violations.some((violation) => violation.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish workflow falls back to npm tokens', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(workflowPath, fs.readFileSync(workflowPath, 'utf8')
            .replace('          npm stage publish "', '          NODE_AUTH_TOKEN=fixture npm stage publish "'));
        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);
        assert.equal(result.passed, false);
        assert.match(output, /publish workflow avoids npm tokens, --provenance override, and self-hosted runners=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when manual Publish also allows automatic tag push', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                'on:\n  workflow_dispatch:',
                'on:\n  push:\n    tags: [v*]\n  workflow_dispatch:'
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish\.yml accepts only manual dispatch=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when manual Publish dispatch is replaced by a release event', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                'on:\n  workflow_dispatch:',
                'on:\n  release:'
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish\.yml accepts only manual dispatch=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish workflow omits Node version pin', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace("env:\n  NODE_VERSION: '24'\n", '')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish workflow pins Node 24 for Trusted Publishing=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish workflow downgrades Node version pin', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace("NODE_VERSION: '24'", "NODE_VERSION: '22'")
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish workflow pins Node 24 for Trusted Publishing=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish validate job only echoes version markers', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                /[ ]{6}- name: Validate tag and package version\n[\s\S]+?(?=[ ]{6}- name: Check publication history before validation)/u,
                [
                    '      - run: |',
                    '          echo "${GITHUB_REF_NAME}"',
                    '          node -p "require(\'./package.json\').version"',
                    '          node -p "require(\'./package-lock.json\').version"',
                    '          cat VERSION',
                    ''
                ].join('\n')
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /validate job has fail-closed tag\/version guard=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish validate guard markers are only comments', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                /[ ]{6}- name: Validate tag and package version\n[\s\S]+?(?=[ ]{6}- name: Check publication history before validation)/u,
                [
                    '      - name: Validate tag and package version',
                    '        shell: bash',
                    '        run: |',
                    '          # set -euo pipefail',
                    '          # GITHUB_REF_TYPE',
                    '          # GITHUB_REF_NAME',
                    '          # TAG_VERSION="${GITHUB_REF_NAME#v}"',
                    '          # PACKAGE_VERSION="$(node -p "require(\'./package.json\').version")"',
                    '          # LOCK_VERSION="$(node -p "require(\'./package-lock.json\').version")"',
                    '          # LOCK_ROOT_VERSION="$(node -p "require(\'./package-lock.json\').packages[\'\'].version")"',
                    '          # VERSION_FILE="$(node -e "process.stdout.write(require(\'node:fs\').readFileSync(\'VERSION\', \'utf8\').trim())")"',
                    '          # ${TAG_VERSION}" != "${PACKAGE_VERSION}',
                    '          # ${TAG_VERSION}" != "${LOCK_VERSION}',
                    '          # ${TAG_VERSION}" != "${LOCK_ROOT_VERSION}',
                    '          # ${TAG_VERSION}" != "${VERSION_FILE}',
                    '          # exit 1',
                    ''
                ].join('\n')
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /validate job has fail-closed tag\/version guard=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects CI proof markers printed without running the checks', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        const workflow = fs.readFileSync(workflowPath, 'utf8')
            .replace('          test "$(git rev-parse HEAD)" = "${GITHUB_SHA}"',
                '          echo test "$(git rev-parse HEAD)" = "${GITHUB_SHA}"')
            .replace('          node scripts/release-candidate.cjs verify-ci "${CI_RUN_ID}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
                '          echo node scripts/release-candidate.cjs verify-ci "${CI_RUN_ID}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"');
        writeFile(workflowPath, workflow);
        const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
        assert.match(output, /validate job requires successful CI for the exact release commit=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects a candidate packed inside the checkout', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(workflowPath, fs.readFileSync(workflowPath, 'utf8')
            .replace('CANDIDATE_DIR="${RUNNER_TEMP}/release-candidate"', 'CANDIDATE_DIR="release-candidate"'));
        const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
        assert.match(output, /validate job packs, smokes, and uploads the digest-bound release candidate=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects candidate packing without strict shell checks', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(workflowPath, fs.readFileSync(workflowPath, 'utf8')
            .replace('          set -euo pipefail\n          CANDIDATE_DIR=', '          set -eu\n          CANDIDATE_DIR='));
        const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
        assert.match(output, /validate job packs, smokes, and uploads the digest-bound release candidate=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects a candidate upload without exact-tarball smoke', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(workflowPath, fs.readFileSync(workflowPath, 'utf8')
            .replace('          GARDA_RELEASE_CANDIDATE_PATH="${CANDIDATE_DIR}/${TARBALL_NAME}" npm run test:packaging',
                '          echo "packaging smoke skipped"'));
        const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
        assert.match(output, /validate job packs, smokes, and uploads the digest-bound release candidate=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

// These mutations exercise the reviewed workflow-step hashes, not shell parsing in isolation.
for (const [name, before, after] of [
    ['a masked CI proof', '          node scripts/release-candidate.cjs verify-ci "${CI_RUN_ID}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
        '          node scripts/release-candidate.cjs verify-ci "${CI_RUN_ID}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}" || true'],
    ['a masked candidate verification', '          node scripts/release-candidate.cjs verify "${CANDIDATE_DIR}" "${GITHUB_SHA}" "${GITHUB_REF_NAME}" "${TARBALL_SHA256}" "${TARBALL_NAME}"',
        '          node scripts/release-candidate.cjs verify "${CANDIDATE_DIR}" "${GITHUB_SHA}" "${GITHUB_REF_NAME}" "${TARBALL_SHA256}" "${TARBALL_NAME}" || true'],
    ['negated CI proof', '          node scripts/release-candidate.cjs verify-ci "${CI_RUN_ID}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
        '          ! node scripts/release-candidate.cjs verify-ci "${CI_RUN_ID}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"'],
    ['conditional candidate verification', '          node scripts/release-candidate.cjs verify "${CANDIDATE_DIR}" "${GITHUB_SHA}" "${GITHUB_REF_NAME}" "${TARBALL_SHA256}" "${TARBALL_NAME}"',
        '          if node scripts/release-candidate.cjs verify "${CANDIDATE_DIR}" "${GITHUB_SHA}" "${GITHUB_REF_NAME}" "${TARBALL_SHA256}" "${TARBALL_NAME}"; then\n            true\n          fi'],
    ['conditional CI proof with and-list', '          node scripts/release-candidate.cjs verify-ci "${CI_RUN_ID}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
        '          true && node scripts/release-candidate.cjs verify-ci "${CI_RUN_ID}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"'],
    ['disabled strict shell error handling', '          CANDIDATE_DIR="${RUNNER_TEMP}/release-candidate"',
        '          set +e\\n          CANDIDATE_DIR="${RUNNER_TEMP}/release-candidate"'],
    ['CI proof hidden in a shell assignment', '          node scripts/release-candidate.cjs verify-ci "${CI_RUN_ID}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
        '          PROOF="node scripts/release-candidate.cjs verify-ci ${CI_RUN_ID} ${GITHUB_SHA} ${GITHUB_REPOSITORY}"'],
    ['CI proof hidden in a shell no-op', '          node scripts/release-candidate.cjs verify-ci "${CI_RUN_ID}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
        '          : "node scripts/release-candidate.cjs verify-ci ${CI_RUN_ID} ${GITHUB_SHA} ${GITHUB_REPOSITORY}"'],
    ['smoking a newly packed fixture instead of the candidate', '          GARDA_RELEASE_CANDIDATE_PATH="${CANDIDATE_DIR}/${TARBALL_NAME}" npm run test:packaging',
        '          npm run test:packaging']
] as const) {
    test(`release readiness rejects ${name}`, () => {
        const repoRoot = createReadinessFixture();
        try {
            const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
            const workflow = fs.readFileSync(workflowPath, 'utf8');
            assert.ok(workflow.includes(before));
            writeFile(workflowPath, workflow.replace(before, after));
            const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
            assert.match(output, /trusted-publish-workflow|validate job (requires successful CI|packs, smokes, and uploads)/);
            assert.equal(validateReleaseReadiness(repoRoot).passed, false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
}

test('release readiness fails when trusted publish environment binding is missing', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace('    environment: npm-release\n', '')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish job is npm-release environment bound and uses id-token OIDC staged publishing=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish OIDC permission is missing', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace('      id-token: write\n', '')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish job is npm-release environment bound and uses id-token OIDC staged publishing=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects an echoed npm version in publish sanity checks', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(workflowPath, fs.readFileSync(workflowPath, 'utf8')
            .replace('test "${NPM_VERSION}" = "11.15.0"', 'echo "${NPM_VERSION}" = "11.15.0"'));
        const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
        assert.match(output, /publish job has fail-closed package and npm CLI sanity guard=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects an npm guard present only in heredoc text', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(workflowPath, fs.readFileSync(workflowPath, 'utf8')
            .replace('          test "${NPM_VERSION}" = "11.15.0"',
                '          cat <<EOF\n          test "${NPM_VERSION}" = "11.15.0"\n          EOF'));
        const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
        assert.match(output, /publish job has fail-closed package and npm CLI sanity guard=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects publishing before candidate verification', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        const workflow = fs.readFileSync(workflowPath, 'utf8');
        const verifyStart = workflow.indexOf('      - name: Verify downloaded candidate');
        const stageStart = workflow.indexOf('      - name: Stage the validated tarball with npm Trusted Publishing');
        assert.ok(verifyStart > 0 && stageStart > verifyStart);
        writeFile(workflowPath, workflow.slice(0, verifyStart)
            + workflow.slice(stageStart) + workflow.slice(verifyStart, stageStart));
        const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
        assert.match(output, /publish job verifies and stages the exact validated tarball without rebuilding=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

for (const [name, before, after] of [
    ['a download from another workflow run', 'gh run download "${GITHUB_RUN_ID}"', 'gh run download "${GITHUB_SHA}"'],
    ['verification whose failure is ignored', '"${EXPECTED_SHA256}" "${EXPECTED_NAME}"', '"${EXPECTED_SHA256}" "${EXPECTED_NAME}" || true'],
    ['staging a different tarball', 'npm stage publish "${RUNNER_TEMP}/release-candidate/${EXPECTED_NAME}"', 'npm stage publish "${RUNNER_TEMP}/other.tgz"'],
    ['a command between verification and staging', '      - name: Stage the validated tarball with npm Trusted Publishing', '      - run: rm -f "${RUNNER_TEMP}/release-candidate/${EXPECTED_NAME}"\n      - name: Stage the validated tarball with npm Trusted Publishing']
] as const) {
    test(`release readiness rejects ${name}`, () => {
        const repoRoot = createReadinessFixture();
        try {
            const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
            const workflow = fs.readFileSync(workflowPath, 'utf8');
            assert.ok(workflow.includes(before));
            writeFile(workflowPath, workflow.replace(before, after));
            const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
            assert.match(output, /publish job verifies and stages the exact validated tarball without rebuilding=false/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
}

test('release readiness rejects a sibling job that stages an unvalidated tarball', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        const workflow = fs.readFileSync(workflowPath, 'utf8');
        const siblingJob = [
            '  shadow-publish:',
            '    needs: validate',
            '    runs-on: ubuntu-latest',
            '    permissions:',
            '      contents: read',
            '      id-token: write',
            '    steps:',
            '      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0',
            '        with:',
            "          node-version: '24'",
            '          registry-url: https://registry.npmjs.org',
            '      - run: |',
            '          npm pack',
            '          npm stage publish ./unvalidated.tgz'
        ].join('\n');
        writeFile(workflowPath, workflow + '\n' + siblingJob);
        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);
        assert.equal(result.passed, false);
        assert.match(output, /publish workflow exactly matches the reviewed release path=false/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness ignores a trusted publish job decoy inside a run script', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        const workflow = fs.readFileSync(workflowPath, 'utf8');
        const trustedPublishJob = workflow.slice(workflow.indexOf('\n  publish:') + 1);
        const realJobMutation = workflow.replace(
            '          npm stage publish "${RUNNER_TEMP}/release-candidate/${EXPECTED_NAME}"',
            '          npm pack'
        );
        const proofStep = '      - name: Require successful CI for this release commit';
        const decoy = [
            '      - name: Inert publish job text',
            '        run: |',
            "          : <<'PUBLISH_DECOY'",
            ...trustedPublishJob.split('\n').map((line) => '        ' + line),
            '          end:',
            '          PUBLISH_DECOY',
            '',
            proofStep
        ].join('\n');
        assert.ok(realJobMutation.includes(proofStep));
        writeFile(workflowPath, realJobMutation.replace(proofStep, decoy));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);
        assert.equal(result.passed, false);
        assert.match(output, /publish job verifies and stages the exact validated tarball without rebuilding=false/u);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects an additional direct npm publish before candidate staging', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        const workflow = fs.readFileSync(workflowPath, 'utf8');
        const downloadMarker = '      - name: Download validated release candidate';
        writeFile(workflowPath, workflow.replace(downloadMarker,
            '      - run: npm publish ./other.tgz\n' + downloadMarker));
        const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
        assert.match(output, /publish job verifies and stages the exact validated tarball without rebuilding=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

for (const command of ['npm pack', 'npm run build', 'npm install -g npm@12.0.0', '"npm" pack', 'n\\pm run build']) {
    test(`release readiness rejects publish job mutation: ${command}`, () => {
        const repoRoot = createReadinessFixture();
        try {
            const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
            const workflow = fs.readFileSync(workflowPath, 'utf8');
            const downloadMarker = '      - name: Download validated release candidate';
            assert.ok(workflow.includes(downloadMarker));
            writeFile(workflowPath, workflow.replace(downloadMarker,
                `      - run: ${command}\n` + downloadMarker));
            const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
            assert.match(output, /publish job verifies and stages the exact validated tarball without rebuilding=false/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
}

test('release readiness fails when trusted publish workflow uses direct npm publish', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(workflowPath, fs.readFileSync(workflowPath, 'utf8')
            .replace('          npm stage publish "', '          npm publish "'));
        const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
        assert.match(output, /publish job verifies and stages the exact validated tarball without rebuilding=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish command is only heredoc text', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(workflowPath, fs.readFileSync(workflowPath, 'utf8')
            .replace('          npm stage publish "${RUNNER_TEMP}/release-candidate/${EXPECTED_NAME}"',
                '          cat <<EOF\n          npm stage publish "${RUNNER_TEMP}/release-candidate/${EXPECTED_NAME}"\n          EOF'));
        const output = formatReleaseReadinessResult(validateReleaseReadiness(repoRoot));
        assert.match(output, /publish job verifies and stages the exact validated tarball without rebuilding=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish operator docs are missing', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(path.join(repoRoot, 'docs', 'run-methods.md'), 'npm run validate:release\n');

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /docs\/run-methods\.md documents GitHub Environment and npm Trusted Publisher setup=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-docs:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish tag restriction docs are missing', () => {
    const repoRoot = createReadinessFixture();
    try {
        const runMethodsPath = path.join(repoRoot, 'docs', 'run-methods.md');
        writeFile(
            runMethodsPath,
            fs.readFileSync(runMethodsPath, 'utf8').replace('selected deployment branches/tags\nv*\n', '')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /docs\/run-methods\.md documents GitHub Environment and npm Trusted Publisher setup=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-docs:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when residual release-security workflow evidence is missing', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, '.github', 'workflows', 'security.yml'));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.match(output, /blocking: security\.yml npm audit high-severity gate present=false/);
        assert.ok(
            result.violations.includes('security-ci: existing release-security CI checks are present and labelled blocking or informational')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when release-security labels or policy decisions are undocumented', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(path.join(repoRoot, 'docs', 'branch-protection.md'), '# Branch Protection\n');

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /informational: branch protection required-check guidance labels retained security checks=false/);
        assert.match(output, /informational: GitHub Action pinning decision documented=false/);
        assert.match(output, /informational: update-source policy reporting statuses documented=false/);
        assert.ok(
            result.violations.includes('security-ci: existing release-security CI checks are present and labelled blocking or informational')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects commented release-security workflow commands', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'security.yml'),
            [
                'npm-audit:',
                '  steps:',
                '    - run: |',
                '        # npm audit --audit-level=high --no-fund',
                'osv-scan:',
                '  with:',
                '    scan-args: |',
                '      --lockfile=package-lock.json',
                '  # uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0'
            ].join('\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: security\.yml npm audit high-severity gate present=false/);
        assert.match(output, /informational: security\.yml OSV lockfile scan present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

for (const [workflowName, jobId] of [['secret-scanning', 'gitleaks'], ['sbom', 'sbom']] as const) {
    for (const [label, before, after] of [
        ['automatic trigger', '  workflow_dispatch:', '  push:\n    branches: [dev]\n  workflow_dispatch:'],
        ['mutable action tag', 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0', 'actions/checkout@v7.0.0'],
        ['foreign pinned action', 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
            'actions/checkout@' + 'a'.repeat(40) + ' # v7.0.0'],
        ['foreign selector profile', 'MANUAL_WORKFLOW: ' + workflowName, 'MANUAL_WORKFLOW: ci'],
        ['mutable checkout', 'ref: ${{ github.sha }}', 'ref: dev'],
        ['retained checkout credentials', 'persist-credentials: false', 'persist-credentials: true'],
        ['unbound authorization shell input', 'run: node scripts/manual-workflow-authorization.cjs',
            'run: node scripts/manual-workflow-authorization.cjs ${{ inputs.authorization }}'],
        ['bypassed selected-job guard', "if: ${{ !cancelled() && needs.authorize.result == 'success' && fromJSON(needs.authorize.outputs.selection).jobs['" + jobId + "'].enabled }}",
            'if: ${{ always() }}']
    ]) {
        test('release readiness rejects manual ' + workflowName + ' ' + label, () => {
            const repoRoot = createReadinessFixture();
            try {
                const workflowPath = path.join(repoRoot, '.github/workflows', workflowName + '.yml');
                const original = fs.readFileSync(workflowPath, 'utf8');
                assert.ok(original.includes(before), 'The negative mutation must exercise the real reviewed contract');
                const altered = original.replace(before, after);
                assert.notEqual(altered, original);
                writeFile(workflowPath, altered);
                const result = validateReleaseReadiness(repoRoot);
                assert.equal(result.passed, false);
                assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
                assert.match(formatReleaseReadinessResult(result), workflowName === 'sbom'
                    ? /informational: sbom\.yml CycloneDX artifact generation present=false/
                    : /blocking: secret-scanning\.yml gitleaks gate present=false/);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });
    }
}

test('release readiness rejects an altered shared manual selector for both auxiliary scanners', () => {
    const repoRoot = createReadinessFixture();
    try {
        assert.equal(validateReleaseReadiness(repoRoot).passed, true);
        const selector = path.join(repoRoot, 'scripts/manual-workflow-authorization.cjs');
        fs.appendFileSync(selector, '\n// Unreviewed selector bytes must not inherit an authorization PASS.\n');
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
        const output = formatReleaseReadinessResult(result);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.match(output, /informational: sbom\.yml CycloneDX artifact generation present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects expression comments inside the Gitleaks install scalar', () => {
    const repoRoot = createReadinessFixture();
    try {
        assert.equal(validateReleaseReadiness(repoRoot).passed, true);
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml');
        const original = fs.readFileSync(workflowPath, 'utf8');
        const needle = '          chmod +x "${install_dir}/gitleaks"';
        const expression = '# ${{ fromJSON(\'"\\ncp /usr/bin/true ${install_dir}/gitleaks\\n"\') }}';
        assert.ok(original.includes(needle));
        const altered = original.replace(needle, needle + '\n          ' + expression);
        assert.notEqual(altered, original);
        writeFile(workflowPath, altered);
        // Workflow text is inspected only; neither the expression nor scanner is executed.
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
        assert.match(formatReleaseReadinessResult(result), /blocking: secret-scanning\.yml gitleaks gate present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects expression comments after the SBOM identity heredoc', () => {
    const repoRoot = createReadinessFixture();
    try {
        assert.equal(validateReleaseReadiness(repoRoot).passed, true);
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'sbom.yml');
        const original = fs.readFileSync(workflowPath, 'utf8');
        const needle = '          NODE\n';
        const expression = '# ${{ fromJSON(\'"\\ncp /dev/null sbom.cdx.json\\n"\') }}';
        assert.ok(original.includes(needle));
        const altered = original.replace(needle, needle + '          ' + expression + '\n');
        assert.notEqual(altered, original);
        writeFile(workflowPath, altered);
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
        assert.match(formatReleaseReadinessResult(result), /informational: sbom\.yml CycloneDX artifact generation present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness retains ordinary comment bytes inside scanner run scalars', () => {
    for (const name of ['secret-scanning.yml', 'sbom.yml']) {
        const repoRoot = createReadinessFixture();
        try {
            const workflowPath = path.join(repoRoot, '.github', 'workflows', name);
            const original = fs.readFileSync(workflowPath, 'utf8');
            const altered = original.replace('        run: |\n',
                '        run: |\n          # Unreviewed scalar bytes remain part of the source contract.\n');
            assert.notEqual(altered, original);
            writeFile(workflowPath, altered);
            const result = validateReleaseReadiness(repoRoot);
            assert.equal(result.passed, false);
            assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    }
});

test('release readiness rejects a commented pinned Gitleaks CLI version', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'),
            buildSecretScanningWorkflow((job) => job.replace(
                "        GITLEAKS_VERSION: '8.30.1'",
                "        # GITLEAKS_VERSION: '8.30.1'"
            ))
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects trusted Gitleaks job text outside the jobs mapping', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'),
            buildSecretScanningWorkflow().replace('jobs:\n', 'notes: |\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects a Gitleaks mapping nested below another job', () => {
    const repoRoot = createReadinessFixture();
    try {
        const nestedWorkflow = buildSecretScanningWorkflow()
            .replace(/^  /gmu, '    ')
            .replace('jobs:\n', 'jobs:\n  wrapper:\n');
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'),
            nestedWorkflow
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects trusted Gitleaks text with changed step indentation', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'),
            buildSecretScanningWorkflow().replace(
                '        run: gitleaks git --config .gitleaks.toml --redact --exit-code 1 .',
                '      run: gitleaks git --config .gitleaks.toml --redact --exit-code 1 .'
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects a disconnected Gitleaks download and checksum pipeline', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflow = buildSecretScanningWorkflow((job) => job
            .replace(
                [
                    '        curl --fail --silent --show-error --location --retry 3 \\',
                    '          "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}" \\',
                    '          --output "${install_dir}/${archive}"'
                ].join('\n'),
                [
                    '        curl --fail --silent --show-error --location --retry 3 "https://example.invalid/untrusted.tar.gz" --output "${install_dir}/${archive}"',
                    '        test -n "gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}"'
                ].join('\n')
            )
            .replace(
                "        printf '%s  %s\\n' \"$GITLEAKS_SHA256\" \"${install_dir}/${archive}\" | sha256sum --check --strict",
                "        test -n 'sha256sum --check --strict'"
            ));
        writeFile(path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'), workflow);

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects a success-forcing Gitleaks scan suffix', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'),
            buildSecretScanningWorkflow((job) => job.replace(
                '      run: gitleaks git --config .gitleaks.toml --redact --exit-code 1 .',
                '      run: gitleaks git --config .gitleaks.toml --redact --exit-code 1 . || true'
            ))
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects a Gitleaks scan step that disables failure propagation', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'),
            buildSecretScanningWorkflow((job) => job.replace(
                '      run: gitleaks git --config .gitleaks.toml --redact --exit-code 1 .',
                [
                    '      run: |',
                    '        set +e',
                    '        gitleaks git --config .gitleaks.toml --redact --exit-code 1 .',
                    '        true'
                ].join('\n')
            ))
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects a Gitleaks install step that does not publish its binary path', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'),
            buildSecretScanningWorkflow((job) => job.replace(
                '        echo "$install_dir" >> "$GITHUB_PATH"',
                '        test -x "${install_dir}/gitleaks"'
            ))
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects Gitleaks jobs that continue after failure', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'),
            buildSecretScanningWorkflow((job) => job.replace(
                '  runs-on: ubuntu-latest',
                '  runs-on: ubuntu-latest\n  continue-on-error: true'
            ))
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects shallow checkout for Gitleaks history scanning', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'),
            buildSecretScanningWorkflow((job) => job.replace('        fetch-depth: 0', '        fetch-depth: 1'))
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects commented OSV lockfile argument', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'security.yml'),
            [
                'npm-audit:',
                '  steps:',
                '    - uses: actions/checkout@v7.0.0',
                '    - uses: actions/setup-node@v6',
                '    - run: npm audit --audit-level=high --no-fund',
                'osv-scan:',
                '  uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0',
                '  with:',
                '    scan-args: |',
                '      # --lockfile=package-lock.json'
            ].join('\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /informational: security\.yml OSV lockfile scan present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects commented gitleaks config', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'),
            buildSecretScanningWorkflow((job) => job.replace(
                '      run: gitleaks git --config .gitleaks.toml --redact --exit-code 1 .',
                '      # run: gitleaks git --config .gitleaks.toml --redact --exit-code 1 .'
            ))
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects commented SBOM artifact failure policy', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'sbom.yml'),
            [
                'sbom:',
                '  steps:',
                '    - uses: actions/checkout@v7.0.0',
                '    - uses: actions/setup-node@v6',
                '    - run: npm run sbom:generate',
                '    - uses: actions/upload-artifact@v7.0.1',
                '      with:',
                '        path: |',
                '          sbom.cdx.json',
                '          sbom-toolchain.json',
                '        # if-no-files-found: error'
            ].join('\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /informational: sbom\.yml CycloneDX artifact generation present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

for (const dynamicCommand of [
    'npx --yes @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json',
    'npx -y @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json',
    'npx @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json',
    'npm exec -- @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json',
    'npm install @cyclonedx/cyclonedx-npm',
    'curl https://example.test/install.sh | bash'
]) {
    test(`release readiness rejects dynamic SBOM tool acquisition: ${dynamicCommand}`, () => {
        const repoRoot = createReadinessFixture();
        try {
            writeFile(
                path.join(repoRoot, '.github', 'workflows', 'sbom.yml'),
                buildSbomWorkflow().replace(
                    '        run: npm run sbom:generate',
                    `        run: |\n          npm run sbom:generate\n          ${dynamicCommand}`
                )
            );
            const result = validateReleaseReadiness(repoRoot);
            assert.equal(result.passed, false);
            assert.match(formatReleaseReadinessResult(result), /informational: sbom\.yml CycloneDX artifact generation present=false/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
}

test('release readiness rejects an additional SBOM run step that acquires a tool', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'sbom.yml'),
            buildSbomWorkflow().replace(
                '      - name: Generate CycloneDX SBOM',
                '      - run: npx -y @cyclonedx/cyclonedx-npm\n      - name: Generate CycloneDX SBOM'
            )
        );
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.match(formatReleaseReadinessResult(result), /informational: sbom\.yml CycloneDX artifact generation present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects SBOM installation that runs dependency lifecycle scripts', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'sbom.yml'),
            buildSbomWorkflow().replace(
                'npm ci --ignore-scripts --no-fund --no-audit',
                'npm ci --no-fund --no-audit'
            )
        );
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.match(formatReleaseReadinessResult(result), /informational: sbom\.yml CycloneDX artifact generation present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects SBOM generator version drift from the lockfile', () => {
    const repoRoot = createReadinessFixture();
    try {
        const lockPath = path.join(repoRoot, 'package-lock.json');
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
            packages: Record<string, { version: string; integrity?: string; devDependencies?: Record<string, string> }>;
        };
        lock.packages['node_modules/@cyclonedx/cyclonedx-npm'].version = '6.0.0';
        writeFile(lockPath, JSON.stringify(lock, null, 2));
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.match(formatReleaseReadinessResult(result), /informational: sbom\.yml CycloneDX artifact generation present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness requires toolchain identity in the SBOM upload', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'sbom.yml'),
            buildSbomWorkflow().replace('            sbom-toolchain.json\n', '')
        );
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.match(formatReleaseReadinessResult(result), /informational: sbom\.yml CycloneDX artifact generation present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness requires generation of lockfile and SBOM digests', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'sbom.yml'),
            buildSbomWorkflow().replace("            sbom_sha256: sha256('sbom.cdx.json')", '            sbom_sha256: omitted')
        );
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.match(formatReleaseReadinessResult(result), /informational: sbom\.yml CycloneDX artifact generation present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

for (const [name, search, replacement] of [
    ['generator identity', '            generator: { name: installed.name, version: installed.version, integrity: locked.integrity },', '            generator: omitted,'],
    ['locked integrity check', "          if (!locked?.integrity || manifest.devDependencies['@cyclonedx/cyclonedx-npm'] !== installed.version || locked.version !== installed.version) {", '          if (false) {'],
    ['commented SBOM digest', "            sbom_sha256: sha256('sbom.cdx.json')", "            # sbom_sha256: sha256('sbom.cdx.json')"]
]) {
    test(`release readiness rejects missing ${name} in SBOM identity`, () => {
        const repoRoot = createReadinessFixture();
        try {
            writeFile(path.join(repoRoot, '.github', 'workflows', 'sbom.yml'), buildSbomWorkflow().replace(search, replacement));
            const result = validateReleaseReadiness(repoRoot);
            assert.equal(result.passed, false);
            assert.match(formatReleaseReadinessResult(result), /informational: sbom\.yml CycloneDX artifact generation present=false/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
}

test('release readiness rejects inherited SBOM shell command acquisition', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'sbom.yml'),
            buildSbomWorkflow().replace(
                'jobs:\n',
                'defaults:\n  run:\n    shell: "bash -c \'npx -y @cyclonedx/cyclonedx-npm; bash --noprofile --norc -eo pipefail {0}\'"\njobs:\n'
            )
        );
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.match(formatReleaseReadinessResult(result), /informational: sbom\.yml CycloneDX artifact generation present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects an additional non-run SBOM action step', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'sbom.yml'),
            buildSbomWorkflow().replace(
                '      - name: Generate CycloneDX SBOM',
                '      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0\n      - name: Generate CycloneDX SBOM'
            )
        );
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.match(formatReleaseReadinessResult(result), /informational: sbom\.yml CycloneDX artifact generation present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects mutable action tags in the SBOM source workflow', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'sbom.yml'),
            buildSbomWorkflow().replace(
                'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
                'actions/checkout@v7.0.0'
            )
        );
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.match(formatReleaseReadinessResult(result), /informational: sbom\.yml CycloneDX artifact generation present=false/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects misplaced OSV lockfile argument outside OSV scan args', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'security.yml'),
            [
                'npm-audit:',
                '  steps:',
                '    - uses: actions/checkout@v7.0.0',
                '    - uses: actions/setup-node@v6',
                '    - run: npm audit --audit-level=high --no-fund',
                'osv-scan:',
                '  uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0',
                '  with:',
                '    scan-args: |',
                '      --recursive .',
                'unrelated:',
                '  steps:',
                '    - run: |',
                '        --lockfile=package-lock.json'
            ].join('\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /informational: security\.yml OSV lockfile scan present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects misplaced gitleaks config outside gitleaks step', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml'),
            [
                buildSecretScanningWorkflow((job) => job.replace(
                    '      run: gitleaks git --config .gitleaks.toml --redact --exit-code 1 .',
                    '      run: echo scan omitted'
                )),
                'unrelated:',
                '  steps:',
                '    - name: Unrelated scan',
                '      run: gitleaks git --config .gitleaks.toml --redact --exit-code 1 .'
            ].join('\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /blocking: secret-scanning\.yml gitleaks gate present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects misplaced SBOM artifact failure policy outside upload step', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'sbom.yml'),
            [
                'sbom:',
                '  steps:',
                '    - uses: actions/checkout@v7.0.0',
                '    - uses: actions/setup-node@v6',
                '    - run: npm run sbom:generate',
                '    - uses: actions/upload-artifact@v7.0.1',
                '      with:',
                '        name: sbom-cyclonedx',
                '    - name: Unrelated upload policy',
                '      with:',
                '        path: |',
                '          sbom.cdx.json',
                '          sbom-toolchain.json',
                '        if-no-files-found: error',
                '      run: echo unrelated'
            ].join('\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /informational: sbom\.yml CycloneDX artifact generation present=false/);
        assert.ok(result.violations.some(v => v.startsWith('security-ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when unused-symbol enforcement is removed from quality gates', () => {
    const repoRoot = createReadinessFixture();
    try {
        updatePackageScripts(repoRoot, (scripts) => {
            scripts['typecheck:unused'] = 'tsc -p tsconfig.node-foundation.json --noEmit --pretty false';
            scripts.quality = 'npm run typecheck && npm run lint && npm run coverage && npm run audit:prod';
            scripts['quality:fast'] = 'npm run typecheck && npm run lint && npm run coverage:fast && npm run audit:prod';
        });

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(
            result.violations.includes('security: quality keeps unused-symbol enforcement, production audit, and security document surface aligned')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails while a tracked 1.1.0 checklist item remains open', () => {
    const repoRoot = createReadinessFixture('T-319');
    try {
        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.deepEqual(result.openReleaseChecklistItems, ['T-319 fixture release blocker']);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.match(output, /OpenReleaseChecklistItems: T-319 fixture release blocker/);
        assert.ok(
            result.violations.includes('release-blockers: tracked Release 1.1.0 readiness checklist is complete')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness does not read local TASK.md as release blocker truth', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'TASK.md'));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, true, output);
        assert.match(output, /ReleaseChecklistItems: 28/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails closed when the tracked checklist is missing', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'docs', 'release-readiness.md'));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.match(output, /Missing tracked release checklist: docs\/release-readiness\.md/);
        assert.ok(
            result.violations.includes('release-blockers: tracked Release 1.1.0 readiness checklist is complete')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails closed when the checklist exists but is untracked', () => {
    const repoRoot = createReadinessFixture();
    try {
        runGit(repoRoot, ['rm', '--cached', '--', 'docs/release-readiness.md']);

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.match(output, /Untracked release checklist: docs\/release-readiness\.md/);
        assert.ok(
            result.violations.includes('release-blockers: tracked Release 1.1.0 readiness checklist is complete')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness matches exact tracked checklist version heading', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, 'docs', 'release-readiness.md'),
            [
                '# Release Readiness',
                '',
                '## 1.1.0-alpha',
                '',
                '- [x] prerelease checklist must not satisfy 1.1.0',
                '',
                '## 1.1.0',
                '',
                '- [ ] final release checklist item'
            ].join('\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /ReleaseChecklistItems: 1/);
        assert.match(output, /OpenReleaseChecklistItems: final release checklist item/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness accepts reviewed multiline manual CI lifecycle smoke run steps', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
        assert.match(workflow, /name: Lifecycle smoke[^\n]*\n {8}id: lifecycle-smoke\n {8}shell: bash\n {8}run: \|/u);

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, true, output);
        assert.match(output, /RELEASE_READINESS_OK/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects legacy CI lifecycle steps without manual authorization even with chomping indicators', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
            buildCiWorkflow({
                smokeSteps: [
                    '    - name: lifecycle smoke',
                    '      run: |-',
                    '        $CLI setup --target-root "$SMOKE_DIR"',
                    '        $CLI update git --target-root "$SMOKE_DIR"',
                    '        $CLI doctor --target-root "$SMOKE_DIR"',
                    '        $CLI uninstall --target-root "$SMOKE_DIR"'
                ].join('\n')
            })
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false, output);
        assert.equal(result.checks.find(check => check.area === 'ci')?.passed, false);
        assert.match(output, /reviewed manual complete-suite contract/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects commented or echoed CI lifecycle smoke markers', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
            buildCiWorkflow({
                smokeSteps: [
                    '    - name: lifecycle smoke',
                    '      run: |',
                    '        # $CLI setup --target-root "$SMOKE_DIR"',
                    '        echo "$CLI update git --target-root $SMOKE_DIR"',
                    '        $CLI doctor --target-root "$SMOKE_DIR"',
                    '        $CLI uninstall --target-root "$SMOKE_DIR"'
                ].join('\n')
            })
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.startsWith('ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness rejects CI lifecycle smoke markers inside heredoc payloads', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
            buildCiWorkflow({
                smokeSteps: [
                    '    - name: lifecycle smoke',
                    '      run: |',
                    "        cat <<'EOF'",
                    '        $CLI setup --target-root "$SMOKE_DIR"',
                    '        $CLI update git --target-root "$SMOKE_DIR"',
                    '        $CLI doctor --target-root "$SMOKE_DIR"',
                    '        $CLI uninstall --target-root "$SMOKE_DIR"',
                    '        EOF'
                ].join('\n')
            })
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.startsWith('ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when Node matrix markers are outside required CI jobs', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
            buildCiWorkflow({ includeNodeVersionInJobs: false })
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.startsWith('ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when CLI tests are not sharded in CI', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                /test-cli:[\s\S]*?test-lifecycle:/u,
                [
                    'test-cli:',
                    '  strategy:',
                    '    matrix:',
                    '      node-version:',
                    '        - \'22.13.0\'',
                    '        - \'24\'',
                    '  steps:',
                    '    - run: npm run test:cli',
                    'test-lifecycle:'
                ].join('\n')
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /reviewed manual complete-suite contract/);
        assert.ok(result.violations.some(v => v.startsWith('ci:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when full-suite optimization guardrails are missing from platform docs', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, 'docs', 'node-platform-foundation.md'),
            [
                '### npm run validate:release',
                'The cross-platform lifecycle smoke proves update runtime behavior.'
            ].join('\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.startsWith('runtime-state:')), output);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when shipped security docs are missing from MANIFEST', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(path.join(repoRoot, 'MANIFEST.md'), '- package.json\n- SECURITY.md\n');

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(
            result.violations.includes('security: quality keeps unused-symbol enforcement, production audit, and security document surface aligned')
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when SECURITY.md is missing from filesystem', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'SECURITY.md'));

        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('security:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when docs/threat-model.md is missing from filesystem', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'docs', 'threat-model.md'));

        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('security:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when docs/sbom.md is missing from filesystem', () => {
    const repoRoot = createReadinessFixture();
    try {
        fs.unlinkSync(path.join(repoRoot, 'docs', 'sbom.md'));

        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('security:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when SECURITY.md is missing from package.json files', () => {
    const repoRoot = createReadinessFixture();
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        pkg.files = pkg.files.filter((f: string) => f !== 'SECURITY.md');
        writeFile(path.join(repoRoot, 'package.json'), JSON.stringify(pkg, null, 2));

        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('security:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when compiled-only package surface includes src', () => {
    const repoRoot = createReadinessFixture();
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        pkg.files.push('src/**');
        writeFile(path.join(repoRoot, 'package.json'), JSON.stringify(pkg, null, 2));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.includes('compiled-only runtime, and linked public-doc contracts')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when compiled-only package surface includes a broad glob', () => {
    const repoRoot = createReadinessFixture();
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        pkg.files.push('**');
        writeFile(path.join(repoRoot, 'package.json'), JSON.stringify(pkg, null, 2));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.includes('compiled-only runtime, and linked public-doc contracts')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when package files omit a README-linked public doc', () => {
    const repoRoot = createReadinessFixture();
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        pkg.files = pkg.files.filter((f: string) => f !== 'docs/cli-reference.md');
        writeFile(path.join(repoRoot, 'package.json'), JSON.stringify(pkg, null, 2));

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.includes('linked public-doc contracts')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when MANIFEST omits a README-linked public doc', () => {
    const repoRoot = createReadinessFixture();
    try {
        const manifest = fs.readFileSync(path.join(repoRoot, 'MANIFEST.md'), 'utf8');
        writeFile(
            path.join(repoRoot, 'MANIFEST.md'),
            manifest
                .split(/\r?\n/u)
                .filter(line => !line.includes('docs/cli-reference.md'))
                .join('\n')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /RELEASE_READINESS_FAILED/);
        assert.ok(result.violations.some(v => v.includes('linked public-doc contracts')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when package files include node test build output', () => {
    const repoRoot = createReadinessFixture();
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
        pkg.files.push('.node-build');
        writeFile(path.join(repoRoot, 'package.json'), JSON.stringify(pkg, null, 2));

        const result = validateReleaseReadiness(repoRoot);

        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('compiled-only runtime, and linked public-doc contracts')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release validation command dispatch accepts only the fixed command allow-list', () => {
    assert.deepEqual(
        [...RELEASE_VALIDATION_COMMANDS],
        [
            'version-parity',
            'clean-worktree',
            'embedded-bundle-parity',
            'release-readiness',
            'package-surface',
            'package-surface-baseline'
        ]
    );
    assert.equal(resolveReleaseValidationCommand(undefined), 'version-parity');
    assert.equal(resolveReleaseValidationCommand(' release-readiness '), 'release-readiness');
    assert.equal(resolveReleaseValidationCommand('release-readiness && npm publish'), null);
    assert.equal(resolveReleaseValidationCommand('$(npm publish)'), null);
    assert.deepEqual(Object.keys(RELEASE_VALIDATION_COMMAND_HANDLERS), [...RELEASE_VALIDATION_COMMANDS]);
});

test('release validation CLI dispatch rejects unknown raw argv before handler lookup', () => {
    const originalExit = process.exit;
    const originalError = console.error;
    const errors: string[] = [];
    let exitCode: string | number | null | undefined = null;

    try {
        console.error = (message?: unknown) => {
            errors.push(String(message));
        };
        process.exit = ((code?: string | number | null | undefined) => {
            exitCode = code;
            throw new Error('process.exit');
        }) as typeof process.exit;

        assert.throws(() => {
            runReleaseValidationCli('release-readiness && npm publish');
        }, /process\.exit/);

        assert.equal(exitCode, 1);
        assert.match(errors.join('\n'), /Unknown validate-release command/);
        assert.match(errors.join('\n'), /version-parity\|clean-worktree\|embedded-bundle-parity\|release-readiness/);
    } finally {
        process.exit = originalExit;
        console.error = originalError;
    }
});

const CANDIDATE_TEST_NOW = new Date('2026-09-26T10:00:00.000Z');
const CANDIDATE_TEST_REPOSITORY = 'Garda-Studio/garda-agent-orchestrator';
const publicationCi = require(path.join(process.cwd(), 'scripts/release-candidate.cjs')) as {
    verifyCiRun(runId: string | number, commit: string, repository: string, dependencies?: {
        root: string; now: Date; fetch: GithubEvidenceFetcher;
    }): { run_id: number; run_attempt: number; verified_jobs: number; attempts: number[] };
};

function candidateQueue(extraRows: string[] = []): string {
    return [
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| T-001 | DONE | P1 | release/proof | Release prerequisite | codex | 2026-09-26 | balanced | |',
        '| T-057 | DONE | P1 | release/candidate-dev-toolchain-audit-proof | Candidate security proof | codex | 2026-09-26 | balanced | |',
        ...extraRows,
        '| T-060 | TODO | P1 | release/pre-release-go-no-go | Final handoff | codex | 2026-09-26 | balanced | |',
        '| T-083 | DONE | P4 | release/release-provenance-checksum-policy | Public artifact policy | codex | 2026-09-26 | balanced | Manual closeout authorized by operator. |',
        '| T-100 | TODO | P2 | workflow/feature | Future feature parent | codex | 2026-09-26 | balanced | Post-release only; optional feature. |'
    ].join('\n');
}

function ciJobFixture(commit: string): Record<string, unknown>[] {
    const names: [string, string[]][] = [['Authorize CI selection', ['Authorize selected jobs']]];
    for (const node of ['22.13.0', '24']) {
        for (const [name, step] of [
            ['Static Checks', 'Run typecheck'], ['Unit Tests', 'Run unit tests'],
            ['Gate Tests', 'Run gate tests (parallel shards)'], ['CLI Tests', 'Run CLI tests (parallel shards)'],
            ['Lifecycle Tests', 'Run lifecycle tests'], ['Binary Tests', 'Run binary tests']
        ]) names.push([name + ' / Node ' + node, name === 'Static Checks' ? ['Validate workflow references', step, 'Run lint'] : name === 'Unit Tests'
            ? ['Install ripgrep for compact integration tests', 'Build node-foundation', step]
            : ['Build node-foundation', step]]);
        for (const os of ['ubuntu-latest', 'windows-latest']) names.push(['Release Validation / ' + os + ' / Node ' + node, [
            'Install ripgrep for compact integration tests (' + (os === 'ubuntu-latest' ? 'Linux' : 'Windows') + ')',
            'Prepare embedded release bundle', 'Bootstrap embedded release bundle', 'Validate release'
        ]]);
        for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) names.push(['Smoke / ' + os + ' / Node ' + node, [
            'Build', 'Build staged node-foundation test graph', 'Pack and install smoke test',
            'Lifecycle smoke (cross-platform E2E install → update → uninstall)'
        ]]);
    }
    return names.map(([name, steps], index) => ({
        id: index + 100, run_id: 41, run_attempt: 1, head_sha: commit, name, status: 'completed', conclusion: 'success',
        started_at: '2026-09-26T09:00:00Z', completed_at: '2026-09-26T09:30:00Z',
        steps: (name === 'Authorize CI selection' ? steps : ['Install dependencies', ...steps]).map(step => ({ name: step, status: 'completed', conclusion: 'success' }))
    }));
}

function createCandidateReadinessFixture(repository = CANDIDATE_TEST_REPOSITORY): {
    root: string; request: CandidateReadinessRequest; fetch: GithubEvidenceFetcher; ci: Record<string, unknown>;
    jobs: Record<string, unknown>[]; securityRun: Record<string, unknown>; securityJobs: Record<string, unknown>[];
} {
    const root = createReadinessFixture();
    try {
        runGit(root, ['rm', '--cached', 'TASK.md']);
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const sourceMetadata = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
        manifest.scripts = sourceMetadata.scripts;
        manifest.repository = sourceMetadata.repository;
        writeFile(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2));
        pinReadinessFixtureActions(root);
        for (const file of ['ci.yml', 'security.yml']) {
            writeFile(path.join(root, '.github', 'workflows', file), fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', file), 'utf8'));
        }
        for (const file of ['release-candidate.cjs', 'release-candidate-ci-evidence.cjs', 'release-security-evidence.cjs', 'validate-workflow-references.cjs', 'manual-ci-evidence.cjs', 'manual-workflow-authorization.cjs']) {
            writeFile(path.join(root, 'scripts', file), fs.readFileSync(path.join(process.cwd(), 'scripts', file), 'utf8'));
        }
        writeFile(path.join(root, 'TASK.md'), candidateQueue());
        writeFile(path.join(root, '.gitignore'), 'release-proof/\nTASK.md\n');
        for (const item of EMBEDDED_BUNDLE_PARITY_ITEMS) {
            const source = path.join(root, item);
            if (!fs.existsSync(source)) writeFile(source, 'deterministic fixture surface\n');
            fs.mkdirSync(path.dirname(path.join(root, 'garda-agent-orchestrator', item)), { recursive: true });
            fs.cpSync(source, path.join(root, 'garda-agent-orchestrator', item), { recursive: true });
        }
        runGit(root, ['add', '.']);
        commitFixture(root, 'fixture: freeze candidate');
        const head = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
        assert.equal(head.status, 0);
        const commit = head.stdout.trim();
        const directory = path.join(root, 'release-proof');
        const packageContent = JSON.stringify({ name: 'garda-agent-orchestrator', version: '1.1.0' }) + '\n';
        writeFile(path.join(directory, 'package', 'package.json'), packageContent);
        const tarballName = 'garda-agent-orchestrator-1.1.0.tgz';
        const tarball = path.join(directory, tarballName);
        const packed = childProcess.spawnSync('tar', ['-czf', tarball, '-C', directory, 'package'], { windowsHide: true, encoding: 'utf8' });
        assert.equal(packed.status, 0, packed.stderr);
        const adapter = require(path.join(process.cwd(), 'scripts', 'release-candidate.cjs')) as {
            createManifest(report: unknown, directory: string, commit: string, tag: string, name: string, version: string): { tarball_sha256: string };
        };
        const candidate = adapter.createManifest([{
            name: 'garda-agent-orchestrator', version: '1.1.0', filename: tarballName,
            size: fs.statSync(tarball).size, entryCount: 1, unpackedSize: Buffer.byteLength(packageContent),
            files: [{ path: 'package.json', size: Buffer.byteLength(packageContent) }]
        }], directory, commit, 'v1.1.0', 'garda-agent-orchestrator', '1.1.0');
        writeFile(path.join(directory, 'candidate-manifest.json'), JSON.stringify(candidate));
        const request = { candidateDirectory: directory, commit, tag: 'v1.1.0', tarballSha256: candidate.tarball_sha256,
            tarballName, repository, ciRunId: 41 };
        const ci: Record<string, unknown> = { id: 41, head_sha: commit, repository: { full_name: request.repository },
            path: '.github/workflows/ci.yml', head_branch: 'dev', event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
            run_attempt: 1, run_started_at: '2026-09-26T09:00:00Z', updated_at: '2026-09-26T09:30:00Z' };
        const jobs = ciJobFixture(commit);
        const securityRun: Record<string, unknown> = { ...ci, id: 42, path: '.github/workflows/security.yml' };
        const securityJobs: Record<string, unknown>[] = ['npm audit', 'OSV Vulnerability Scan / osv-scan', 'Authorize Security selection'].map((name, index) => ({
            id: 501 + index, run_id: 42, run_attempt: 1, head_sha: commit, name, status: 'completed', conclusion: 'success',
            started_at: ci.run_started_at, completed_at: ci.updated_at,
            steps: (index === 0 ? ['Pin release audit npm CLI', 'Install dependencies', 'Audit dependencies'] :
                index === 1 ? ['Run scanner', 'Run osv-scanner-reporter'] : ['Authorize selected jobs'])
                .map(step => ({ name: step, status: 'completed', conclusion: 'success' }))
        }));
        const fetch: GithubEvidenceFetcher = endpoint => {
            const expected = ['repos/' + repository + '/actions/runs/41', 'repos/' + repository + '/actions/runs/41/jobs?filter=all&per_page=100',
                'repos/' + repository + '/actions/runs/42', 'repos/' + repository + '/actions/runs/42/jobs?filter=all&per_page=100'];
            assert.ok(expected.includes(endpoint), 'Unexpected offline fixture repository endpoint: ' + endpoint);
            if (endpoint.includes('/runs/41')) return endpoint.includes('/jobs') ? [{ total_count: jobs.length, jobs }] : ci;
            if (endpoint.includes('/runs/42')) return endpoint.includes('/jobs') ? [{ total_count: securityJobs.length, jobs: securityJobs }] : securityRun;
            throw new Error('Unexpected offline fixture endpoint.');
        };
        const security = require(path.join(process.cwd(), 'scripts', 'release-security-evidence.cjs')) as {
            attestOrVerify(mode: string, args: string[], root: string, now: Date, fetch: () => unknown): unknown;
        };
        security.attestOrVerify('attest', [directory, commit, request.tag, request.tarballSha256, tarballName, request.repository, '42'],
            root, CANDIDATE_TEST_NOW, () => ({ run: securityRun, jobs: [{ total_count: securityJobs.length, jobs: securityJobs }] }));
        return { root, request, fetch, ci, jobs, securityRun, securityJobs };
    } catch (error) {
        fs.rmSync(root, { recursive: true, force: true });
        throw error;
    }
}

test('candidate readiness combines real Git and tarball proof with complete offline CI/security payloads for GO', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.passed, true, formatReleaseReadinessResult(result));
        assert.equal(result.candidate?.decision, 'GO');
        assert.match(formatReleaseReadinessResult(result), /ReleaseDecision: GO/);
        assert.equal(result.candidate?.taskQueueSha256,
            crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture.root, 'TASK.md'))).digest('hex'));
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects legacy Security records and missing or altered schema-2 bindings', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const evidencePath = path.join(fixture.request.candidateDirectory, 'security-evidence.json');
        const original = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
            schema_version?: number; security: Record<string, unknown>;
        };
        assert.equal(original.schema_version, 2);
        assert.equal(original.security.selector_sha256, 'cb34c3544940e746ad023a8fa4c9e6de4b789fec05e1cdef106bbb7c0da034a5');
        assert.equal(original.security.osv_checkout_ref, fixture.request.commit);
        const mutations = [
            (record: typeof original) => { record.schema_version = 1; },
            (record: typeof original) => { delete record.schema_version; },
            (record: typeof original) => { delete record.security.selector_sha256; },
            (record: typeof original) => { record.security.selector_sha256 = 'd'.repeat(64); },
            (record: typeof original) => { delete record.security.osv_checkout_ref; },
            (record: typeof original) => { record.security.osv_checkout_ref = 'd'.repeat(40); },
            (record: typeof original) => {
                record.schema_version = 1;
                delete record.security.selector_sha256;
                delete record.security.osv_checkout_ref;
            }
        ];
        for (const mutate of mutations) {
            const record = structuredClone(original);
            mutate(record);
            const altered = JSON.stringify(record);
            fs.writeFileSync(evidencePath, altered);
            const result = validateReleaseReadiness(fixture.root, fixture.request,
                { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
            assert.equal(result.passed, false);
            assert.equal(result.candidate?.decision, 'NO_GO');
            assert.equal(result.checks.find(check => check.area === 'candidate-security')?.passed, false);
            assert.equal(fs.readFileSync(evidencePath, 'utf8'), altered);
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness accepts retained security scans only through authenticated attempt fetches', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const prior = { ...fixture.securityRun, conclusion: 'failure' };
        const retry = { ...fixture.securityJobs[1], id: 601, run_attempt: 2,
            started_at: '2026-09-26T09:40:00Z', completed_at: '2026-09-26T09:45:00Z' };
        fixture.securityJobs[1].conclusion = 'failure';
        fixture.securityJobs.push(retry);
        Object.assign(fixture.securityRun, { run_attempt: 2,
            run_started_at: '2026-09-26T09:40:00Z', updated_at: '2026-09-26T09:50:00Z' });
        const r = fixture.request;
        const adapter = require(path.join(process.cwd(), 'scripts/release-security-evidence.cjs')) as {
            attestOrVerify(mode: string, args: string[], root: string, now: Date, fetch: () => unknown): unknown;
        };
        fs.unlinkSync(path.join(r.candidateDirectory, 'security-evidence.json'));
        adapter.attestOrVerify('attest', [r.candidateDirectory, r.commit, r.tag, r.tarballSha256,
            r.tarballName, r.repository, '42'], fixture.root, CANDIDATE_TEST_NOW,
        () => ({ run: fixture.securityRun, jobs: { total_count: fixture.securityJobs.length, jobs: fixture.securityJobs },
            fetchAttempt: () => prior }));
        const endpoints: string[] = [];
        const fetch: GithubEvidenceFetcher = (endpoint, paginate) => {
            endpoints.push(endpoint);
            if (endpoint.endsWith('/42/attempts/1')) return prior;
            if (endpoint.includes('/42/jobs')) assert.equal(paginate, true);
            return fixture.fetch(endpoint, paginate);
        };
        const result = validateReleaseReadiness(fixture.root, r, { now: CANDIDATE_TEST_NOW, fetch });
        assert.equal(result.candidate?.decision, 'GO', formatReleaseReadinessResult(result));
        assert.equal(result.checks.find(check => check.area === 'candidate-security')?.passed, true);
        assert.ok(endpoints.some(endpoint => endpoint.endsWith('/42/jobs?filter=all&per_page=100')));
        assert.ok(endpoints.some(endpoint => endpoint.endsWith('/42/attempts/1')));
        for (const mutation of [{ head_sha: 'a'.repeat(40) }, { event: 'push' }, { run_attempt: 2 },
            { run_started_at: '2026-09-26T09:55:00Z', updated_at: '2026-09-26T09:56:00Z' }]) {
            const invalid = validateReleaseReadiness(fixture.root, r, { now: CANDIDATE_TEST_NOW,
                fetch: (endpoint, paginate) => endpoint.endsWith('/42/attempts/1') ? { ...prior, ...mutation } : fetch(endpoint, paginate) });
            assert.equal(invalid.candidate?.decision, 'NO_GO');
            assert.equal(invalid.checks.find(check => check.area === 'candidate-security')?.passed, false);
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects automatic and partial security evidence at the actual adapter boundary', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const automatic = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW,
            fetch: (endpoint, paginate) => endpoint.endsWith('/42')
                ? { ...fixture.securityRun, event: 'push' } : fixture.fetch(endpoint, paginate) });
        assert.equal(automatic.candidate?.decision, 'NO_GO');
        assert.equal(automatic.checks.find(check => check.area === 'candidate-security')?.passed, false);
        fixture.securityJobs.splice(1, 1);
        const partial = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(partial.candidate?.decision, 'NO_GO');
        assert.equal(partial.checks.find(check => check.area === 'candidate-security')?.passed, false);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects foreign, stale, skipped, empty and replayed suite evidence', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        for (const mutation of [
            { head_sha: 'a'.repeat(40) }, { conclusion: 'skipped' }, { updated_at: '2026-09-24T09:30:00Z' },
            { repository: { full_name: 'foreign/repo' } }, { run_attempt: 2 }, { event: 'push' },
            { event: 'pull_request' }, { event: 'schedule' }, { head_branch: 'unreviewed' }
        ]) {
            const result = validateReleaseReadiness(fixture.root, fixture.request, {
                now: CANDIDATE_TEST_NOW, fetch: endpoint => endpoint.endsWith('/41') ? { ...fixture.ci, ...mutation } : fixture.fetch(endpoint)
            });
            assert.equal(result.candidate?.decision, 'NO_GO');
            assert.equal(result.checks.find(check => check.area === 'candidate-suite')?.passed, false);
        }
        const original = [...fixture.jobs];
        for (const replacement of [[], original.slice(1), [{ ...original[0], conclusion: 'skipped' }, ...original.slice(1)],
            [{ ...original[0], steps: [] }, ...original.slice(1)]]) {
            fixture.jobs.splice(0, fixture.jobs.length, ...replacement);
            const result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
            assert.equal(result.candidate?.decision, 'NO_GO');
            assert.equal(result.checks.find(check => check.area === 'candidate-suite')?.passed, false);
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness accepts a narrow failed-job rerun only with complete authenticated same-SHA history', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const prior = { ...fixture.ci, conclusion: 'failure' };
        const failed = fixture.jobs.find(job => job.name === 'Smoke / windows-latest / Node 24')!;
        const retry = { ...failed, id: 900, run_attempt: 2,
            started_at: '2026-09-26T09:40:00Z', completed_at: '2026-09-26T09:45:00Z' };
        failed.conclusion = 'failure';
        fixture.jobs.push(retry);
        Object.assign(fixture.ci, { run_attempt: 2, run_started_at: '2026-09-26T09:40:00Z', updated_at: '2026-09-26T09:50:00Z' });
        const endpoints: string[] = [];
        const fetch: GithubEvidenceFetcher = endpoint => {
            endpoints.push(endpoint);
            return endpoint.endsWith('/41/attempts/1') ? prior : fixture.fetch(endpoint);
        };
        const result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch });
        assert.equal(result.candidate?.decision, 'GO', formatReleaseReadinessResult(result));
        assert.ok(endpoints.some(endpoint => endpoint.endsWith('/41/jobs?filter=all&per_page=100')));
        assert.ok(endpoints.some(endpoint => endpoint.endsWith('/41/attempts/1')));
        assert.equal(fixture.jobs.filter(job => job.run_attempt === 2).length, 1);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness accepts recovered upstream failures only after every skipped matrix family executes', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const original = fixture.jobs.map(job => ({ ...job }));
        const prior: Record<string, unknown> = { ...fixture.ci, conclusion: 'failure' };
        const families = ['Unit Tests', 'Gate Tests', 'CLI Tests', 'Lifecycle Tests', 'Binary Tests', 'Release Validation', 'Smoke'];
        const fetch: GithubEvidenceFetcher = endpoint => endpoint.endsWith('/41/attempts/1') ? prior : fixture.fetch(endpoint);
        const verify = () => validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch });
        Object.assign(fixture.ci, { run_attempt: 2, run_started_at: '2026-09-26T09:40:00Z', updated_at: '2026-09-26T09:50:00Z' });
        for (const failedFamily of ['Static Checks', 'Unit Tests']) {
            const skippedFamilies = failedFamily === 'Static Checks' ? families : ['Release Validation', 'Smoke'];
            const inFamily = (job: Record<string, unknown>, family: string) => String(job.name).startsWith(family + ' / ');
            const historical = original.filter(job => !skippedFamilies.some(family => inFamily(job, family)))
                .map(job => inFamily(job, failedFamily) ? { ...job, conclusion: 'failure' } : { ...job });
            // GitHub retains the literal expression-bearing name when a job-level if skips matrix expansion.
            const skipped = skippedFamilies.map((family, index) => ({
                id: 900 + index, run_id: 41, head_sha: fixture.request.commit, run_attempt: 1,
                name: family + (['Release Validation', 'Smoke'].includes(family)
                    ? ' / ${{ matrix.os }} / Node ${{ matrix.node-version }}' : ' / Node ${{ matrix.node-version }}'),
                status: 'completed', conclusion: 'skipped', steps: [],
                started_at: prior.updated_at, completed_at: prior.updated_at
            }));
            const retried = original.filter(job => [failedFamily, ...skippedFamilies].some(family => inFamily(job, family)))
                .map((job, index) => ({ ...job, id: 1000 + index, run_attempt: 2,
                    started_at: '2026-09-26T09:40:00Z', completed_at: '2026-09-26T09:45:00Z' }));
            const recovered = [...historical, ...skipped, ...retried];
            fixture.jobs.splice(0, fixture.jobs.length, ...recovered);
            const result = verify();
            assert.equal(result.candidate?.decision, 'GO', failedFamily + ': ' + formatReleaseReadinessResult(result));
            assert.equal(result.checks.find(check => check.area === 'candidate-suite')?.passed, true);
            for (const mutation of [
                { name: 'Foreign matrix / Node ${{ matrix.node-version }}' }, { conclusion: 'success' },
                { status: 'queued' }, { run_attempt: 2 }, { head_sha: 'b'.repeat(40) },
                { steps: [{ name: 'Run scanner', status: 'completed', conclusion: 'success' }] },
                { started_at: '2026-09-26T08:00:00Z' }
            ]) {
                fixture.jobs.splice(0, fixture.jobs.length, ...historical, { ...skipped[0], ...mutation }, ...skipped.slice(1), ...retried);
                const invalid = verify();
                assert.equal(invalid.candidate?.decision, 'NO_GO', JSON.stringify(mutation));
                assert.equal(invalid.checks.find(check => check.area === 'candidate-suite')?.passed, false);
            }
            fixture.jobs.splice(0, fixture.jobs.length, ...recovered, { ...skipped[0], id: 999 });
            assert.equal(verify().candidate?.decision, 'NO_GO');
            const unsuperseded = retried.map(job => inFamily(job, skippedFamilies[0])
                ? { ...job, run_attempt: 1, started_at: prior.run_started_at, completed_at: prior.updated_at } : job);
            fixture.jobs.splice(0, fixture.jobs.length, ...historical, ...skipped, ...unsuperseded);
            const missingExecution = verify();
            assert.equal(missingExecution.candidate?.decision, 'NO_GO');
            assert.ok(missingExecution.checks.find(check => check.area === 'candidate-suite')?.details
                .some(value => value.includes('skipped matrix family was not fully superseded')), formatReleaseReadinessResult(missingExecution));
            fixture.jobs.splice(0, fixture.jobs.length, ...historical, ...skipped, ...retried.slice(1));
            assert.equal(verify().candidate?.decision, 'NO_GO');
            fixture.jobs.splice(0, fixture.jobs.length, ...recovered);
            const foreignAttempt = validateReleaseReadiness(fixture.root, fixture.request, {
                now: CANDIDATE_TEST_NOW, fetch: endpoint => endpoint.endsWith('/41/attempts/1')
                    ? { ...prior, head_sha: 'b'.repeat(40) } : fixture.fetch(endpoint)
            });
            assert.equal(foreignAttempt.candidate?.decision, 'NO_GO');
            assert.ok(foreignAttempt.checks.find(check => check.area === 'candidate-suite')?.details
                .some(value => value.includes('CI run belongs to another run, repository or candidate commit')), formatReleaseReadinessResult(foreignAttempt));
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('publication CI proof rejects failed and reversed retained attempts after authenticating the complete manual matrix', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const endpoints: Array<{ endpoint: string; paginate: boolean }> = [];
        const prior = { ...fixture.ci };
        const fetch: GithubEvidenceFetcher = (endpoint, paginate = false) => {
            endpoints.push({ endpoint, paginate });
            return endpoint.endsWith('/attempts/1') ? prior : fixture.fetch(endpoint);
        };
        const verify = () => publicationCi.verifyCiRun('41', fixture.request.commit, fixture.request.repository,
            { root: fixture.root, now: CANDIDATE_TEST_NOW, fetch });
        assert.deepEqual(verify(), { run_id: 41, run_attempt: 1, commit: fixture.request.commit,
            verified_jobs: 23, attempts: [1] });
        assert.ok(endpoints.some(call => call.endpoint.endsWith('/jobs?filter=all&per_page=100') && call.paginate));
        fixture.jobs.push({ ...fixture.jobs[1], id: 900, run_attempt: 2,
            started_at: '2026-09-26T09:40:00Z', completed_at: '2026-09-26T09:45:00Z' });
        Object.assign(fixture.ci, { run_attempt: 2, run_started_at: '2026-09-26T09:40:00Z', updated_at: '2026-09-26T09:50:00Z' });
        assert.deepEqual(verify().attempts, [1, 2]);
        fixture.jobs[fixture.jobs.length - 1].conclusion = 'failure';
        assert.throws(verify, /Latest CI matrix job did not succeed/u);
        fixture.jobs[fixture.jobs.length - 1].conclusion = 'success';
        prior.updated_at = '2026-09-26T09:55:00Z';
        assert.throws(verify, /attempt timelines are reversed or overlapping/u);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('publication CI proof rejects summary-only, missing, partial, skipped, forged and stale success', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const verify = (fetch: GithubEvidenceFetcher = fixture.fetch) => publicationCi.verifyCiRun(41,
            fixture.request.commit, fixture.request.repository, { root: fixture.root, now: CANDIDATE_TEST_NOW, fetch });
        assert.equal(verify().verified_jobs, 23);
        assert.throws(() => verify(() => ({ workflow_runs: [fixture.ci] })), /another run, repository or candidate commit/u);
        const originalRun = { ...fixture.ci };
        for (const mutation of [
            { id: 42 }, { head_sha: 'b'.repeat(40) }, { repository: { full_name: 'foreign/repo' } },
            { event: 'push' }, { event: 'pull_request' }, { head_branch: 'feature' },
            { path: '.github/workflows/foreign.yml' }, { conclusion: 'failure' }, { status: 'in_progress' },
            { updated_at: '2026-09-24T10:00:00Z' }, { updated_at: '2026-09-27T10:00:00Z' }
        ]) {
            Object.assign(fixture.ci, originalRun, mutation);
            assert.throws(() => verify(), JSON.stringify(mutation));
        }
        Object.assign(fixture.ci, originalRun);
        const originalJobs = [...fixture.jobs];
        for (const jobs of [originalJobs.slice(0, 2), originalJobs.slice(1),
            [{ ...originalJobs[0], conclusion: 'skipped' }, ...originalJobs.slice(1)],
            [{ ...originalJobs[0], steps: [] }, ...originalJobs.slice(1)],
            [{ ...originalJobs[0], head_sha: 'b'.repeat(40) }, ...originalJobs.slice(1)],
            [...originalJobs, { ...originalJobs[1], id: 999 }],
            [...originalJobs.slice(0, -1), { ...originalJobs.at(-1), steps: [{ name: 'Install dependencies', status: 'completed', conclusion: 'success' }] }]
        ]) {
            fixture.jobs.splice(0, fixture.jobs.length, ...jobs);
            assert.throws(() => verify());
        }
        fixture.jobs.splice(0, fixture.jobs.length, ...originalJobs);
        assert.throws(() => verify(endpoint => endpoint.includes('/jobs')
            ? [{ total_count: originalJobs.length + 1, jobs: originalJobs }] : fixture.fetch(endpoint)), /history is incomplete/u);
        assert.throws(() => verify(() => { throw new Error('Authenticated Actions evidence unavailable (offline control).'); }), /evidence unavailable/u);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('publication CI transport rejects missing or malformed evidence while pinning host and paginated jobs', t => {
    const fixture = createCandidateReadinessFixture();
    try {
        t.mock.timers.enable({ apis: ['Date'], now: CANDIDATE_TEST_NOW });
        const calls: Array<{ command: unknown; args: string[]; options: childProcess.SpawnSyncOptions }> = [];
        const transport = t.mock.method(require('node:child_process'), 'spawnSync',
            (command: unknown, args: string[], options: childProcess.SpawnSyncOptions) => {
                calls.push({ command, args, options });
                return { status: 0, stdout: JSON.stringify(fixture.fetch(args[3])), stderr: '' };
            });
        assert.equal(publicationCi.verifyCiRun('41', fixture.request.commit, fixture.request.repository).verified_jobs, 23);
        assert.equal(calls.length, 2);
        for (const call of calls) {
            assert.equal(call.command, 'gh');
            assert.deepEqual(call.args.slice(0, 3), ['api', '--hostname', 'github.com']);
            assert.equal(call.options.maxBuffer, 16 * 1024 * 1024);
            assert.equal(call.options.shell, undefined);
            assert.equal(call.options.windowsHide, true);
        }
        assert.deepEqual(calls[1].args.slice(4), ['--paginate', '--slurp']);
        transport.mock.mockImplementation(() => ({ status: 1, stdout: '', stderr: 'not copied into release evidence' }));
        assert.throws(() => publicationCi.verifyCiRun('41', fixture.request.commit, fixture.request.repository),
            /Authenticated GitHub CI evidence is unavailable/u);
        transport.mock.mockImplementation(() => ({ status: 0, stdout: 'not JSON', stderr: '' }));
        assert.throws(() => publicationCi.verifyCiRun('41', fixture.request.commit, fixture.request.repository));
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('release readiness rejects replaced publication CI discovery and token transport', () => {
    const root = createReadinessFixture();
    try {
        const workflowPath = path.join(root, '.github/workflows/publish.yml');
        const original = fs.readFileSync(workflowPath, 'utf8');
        const withoutToken = original.replace('          GH_TOKEN: ${{ github.token }}', '          UNRELATED_TOKEN: ${{ github.token }}');
        assert.notEqual(withoutToken, original);
        writeFile(workflowPath, withoutToken);
        assert.equal(validateReleaseReadiness(root).checks.find(check => check.area === 'trusted-publish-workflow')?.passed, false);
        for (const changed of [
            original.replace('-f event=workflow_dispatch', '-f event=push'),
            original.replace("--jq '.workflow_runs[0].id'", "--jq '.workflow_runs[] | select(.conclusion == \"success\") | .id'"),
            original.replace('verify-ci "${CI_RUN_ID}"', 'verify-ci "41"'),
            original.replace('-f per_page=1', '-f status=completed -f per_page=1')
        ]) {
            assert.notEqual(changed, original);
            writeFile(workflowPath, changed);
            const result = validateReleaseReadiness(root);
            assert.equal(result.checks.find(check => check.area === 'trusted-publish-workflow')?.passed, false,
                formatReleaseReadinessResult(result));
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects a historical skipped matrix family without later full execution', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const staticJob = fixture.jobs.find(job => job.name === 'Static Checks / Node 24')!;
        fixture.jobs.push({ ...staticJob, id: 900, run_attempt: 2, conclusion: 'failure',
            started_at: '2026-09-26T09:35:00Z', completed_at: '2026-09-26T09:45:00Z' });
        fixture.jobs.push({ ...staticJob, id: 901, run_attempt: 3,
            started_at: '2026-09-26T09:50:00Z', completed_at: '2026-09-26T09:55:00Z' });
        fixture.jobs.push({ id: 902, run_id: 41, head_sha: fixture.request.commit, run_attempt: 2,
            name: 'Unit Tests / Node ${{ matrix.node-version }}', status: 'completed', conclusion: 'skipped', steps: [],
            started_at: '2026-09-26T09:45:00Z', completed_at: '2026-09-26T09:45:00Z' });
        Object.assign(fixture.ci, { run_attempt: 3, run_started_at: '2026-09-26T09:50:00Z', updated_at: '2026-09-26T10:00:00Z' });
        const result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
        assert.equal(result.checks.find(check => check.area === 'candidate-suite')?.passed, false);
        assert.ok(result.checks.find(check => check.area === 'candidate-suite')?.details
            .some(value => value.includes('skipped matrix family was not fully superseded')), formatReleaseReadinessResult(result));
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects reversed or overlapping retained attempts despite complete successful job history', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const first = { ...fixture.ci, conclusion: 'failure' };
        const second = { ...fixture.ci, run_attempt: 2, conclusion: 'failure',
            run_started_at: '2026-09-26T09:35:00Z', updated_at: '2026-09-26T09:45:00Z' };
        const windows = fixture.jobs.find(job => job.name === 'Smoke / windows-latest / Node 22.13.0')!;
        const macos = fixture.jobs.find(job => job.name === 'Smoke / macos-latest / Node 24')!;
        fixture.jobs.push({ ...windows, id: 900, run_attempt: 2,
            started_at: second.run_started_at, completed_at: second.updated_at });
        fixture.jobs.push({ ...macos, id: 901, run_attempt: 2, conclusion: 'failure',
            started_at: second.run_started_at, completed_at: second.updated_at });
        fixture.jobs.push({ ...macos, id: 902, run_attempt: 3,
            started_at: '2026-09-26T09:50:00Z', completed_at: '2026-09-26T09:59:00Z' });
        windows.conclusion = 'failure';
        macos.conclusion = 'failure';
        Object.assign(fixture.ci, { run_attempt: 3, run_started_at: '2026-09-26T09:50:00Z', updated_at: '2026-09-26T10:00:00Z' });
        const endpoints: string[] = [];
        const fetch: GithubEvidenceFetcher = endpoint => {
            endpoints.push(endpoint);
            if (endpoint.endsWith('/41/attempts/1')) return first;
            if (endpoint.endsWith('/41/attempts/2')) return second;
            return fixture.fetch(endpoint);
        };
        const verify = () => validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch });
        const setTimeline = (attempt: 1 | 2, started: string, completed: string) => {
            Object.assign(attempt === 1 ? first : second, { run_started_at: started, updated_at: completed });
            for (const job of fixture.jobs.filter(job => job.run_attempt === attempt)) {
                Object.assign(job, { started_at: started, completed_at: completed });
            }
        };
        const ordered = verify();
        assert.equal(ordered.candidate?.decision, 'GO', formatReleaseReadinessResult(ordered));
        assert.ok(endpoints.some(endpoint => endpoint.endsWith('/41/attempts/1')));
        assert.ok(endpoints.some(endpoint => endpoint.endsWith('/41/attempts/2')));
        setTimeline(1, '2026-09-26T09:35:00Z', '2026-09-26T09:45:00Z');
        setTimeline(2, '2026-09-26T09:00:00Z', '2026-09-26T09:30:00Z');
        const reversed = verify();
        assert.equal(reversed.candidate?.decision, 'NO_GO');
        assert.equal(reversed.checks.find(check => check.area === 'candidate-suite')?.passed, false);
        assert.ok(reversed.checks.find(check => check.area === 'candidate-suite')?.details
            .some(value => value.includes('CI attempt timelines are reversed or overlapping')), formatReleaseReadinessResult(reversed));
        setTimeline(1, '2026-09-26T09:00:00Z', '2026-09-26T09:30:00Z');
        setTimeline(2, '2026-09-26T09:20:00Z', '2026-09-26T09:40:00Z');
        const overlapping = verify();
        assert.equal(overlapping.candidate?.decision, 'NO_GO');
        assert.ok(overlapping.checks.find(check => check.area === 'candidate-suite')?.details
            .some(value => value.includes('CI attempt timelines are reversed or overlapping')), formatReleaseReadinessResult(overlapping));
        setTimeline(1, '2026-09-26T09:00:00Z', '2026-09-26T09:35:00Z');
        setTimeline(2, '2026-09-26T09:31:00Z', '2026-09-26T09:34:00Z');
        const reversedCompletion = verify();
        assert.equal(reversedCompletion.candidate?.decision, 'NO_GO');
        assert.ok(reversedCompletion.checks.find(check => check.area === 'candidate-suite')?.details
            .some(value => value.includes('CI attempt timelines are reversed or overlapping')), formatReleaseReadinessResult(reversedCompletion));
        setTimeline(1, '2026-09-26T09:00:00Z', '2026-09-26T09:30:00Z');
        setTimeline(2, '2026-09-26T09:28:00Z', '2026-09-26T09:40:00Z');
        const clockSkewAllowance = verify();
        assert.equal(clockSkewAllowance.candidate?.decision, 'GO', formatReleaseReadinessResult(clockSkewAllowance));
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects replayed, foreign and inconsistent rerun attempts despite a successful run summary', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const prior = { ...fixture.ci, conclusion: 'failure' };
        const original = [...fixture.jobs];
        const retry = { ...original[1], id: 900, run_attempt: 2,
            started_at: '2026-09-26T09:40:00Z', completed_at: '2026-09-26T09:45:00Z' };
        fixture.jobs.push(retry);
        Object.assign(fixture.ci, { run_attempt: 2, run_started_at: '2026-09-26T09:40:00Z', updated_at: '2026-09-26T09:50:00Z' });
        const fetch = (endpoint: string): unknown => endpoint.endsWith('/41/attempts/1') ? prior : fixture.fetch(endpoint);
        for (const mutation of [{ conclusion: 'failure' }, { conclusion: 'skipped' }, { run_attempt: 3 },
            { run_id: 42 }, { head_sha: 'b'.repeat(40) }, { id: original[0].id },
            { started_at: '2026-09-26T09:00:00Z' }, { completed_at: '2026-09-26T10:10:00Z' }]) {
            fixture.jobs.splice(0, fixture.jobs.length, ...original, { ...retry, ...mutation });
            const result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch });
            assert.equal(result.candidate?.decision, 'NO_GO', JSON.stringify(mutation));
            assert.equal(result.checks.find(check => check.area === 'candidate-suite')?.passed, false);
        }
        fixture.jobs.splice(0, fixture.jobs.length, ...original, retry);
        for (const mutation of [{ run_attempt: 2 }, { head_sha: 'b'.repeat(40) }, { id: 42 },
            { repository: { full_name: 'foreign/repo' } }, { event: 'push' },
            { updated_at: '2026-09-26T09:55:00Z' }, { updated_at: '2026-09-24T09:30:00Z' }]) {
            const result = validateReleaseReadiness(fixture.root, fixture.request, {
                now: CANDIDATE_TEST_NOW, fetch: endpoint => endpoint.endsWith('/41/attempts/1') ? { ...prior, ...mutation } : fixture.fetch(endpoint)
            });
            assert.equal(result.candidate?.decision, 'NO_GO', JSON.stringify(mutation));
            assert.equal(result.checks.find(check => check.area === 'candidate-suite')?.passed, false);
        }
        fixture.jobs.push({ ...retry, id: 901 });
        const duplicate = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch });
        assert.equal(duplicate.candidate?.decision, 'NO_GO');
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects partial coverage and missing authorization despite complete-matrix intent', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const original = [...fixture.jobs];
        fixture.ci.complete_matrix_requested = true;
        fixture.jobs.splice(0, fixture.jobs.length, ...original.slice(0, 2));
        const partial = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(partial.candidate?.decision, 'NO_GO');
        assert.equal(partial.checks.find(check => check.area === 'candidate-suite')?.passed, false);
        for (const jobs of [original.slice(1),
            [{ ...original[0], conclusion: 'skipped' }, ...original.slice(1)],
            [{ ...original[0], steps: [] }, ...original.slice(1)],
            [...original, { ...original[0], id: 999 }]]) {
            fixture.jobs.splice(0, fixture.jobs.length, ...jobs);
            const result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
            assert.equal(result.candidate?.decision, 'NO_GO');
            assert.equal(result.checks.find(check => check.area === 'candidate-suite')?.passed, false);
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('release readiness rejects changed manual CI authorization and candidate selector code without executing it', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflow = path.join(repoRoot, '.github/workflows/ci.yml');
        const original = fs.readFileSync(workflow, 'utf8');
        for (const invalid of [original.replace("needs.authorize.result == 'success'", 'true'),
            original.replace('ref: ${{ github.sha }}', 'ref: ${{ inputs.commit }}'),
            original.replace('  workflow_dispatch:', '  push:'),
            original.replace('contents: read', 'contents: write'),
            original.replace('$CLI setup --target-root', 'echo $CLI setup --target-root'),
            original.replace('npm run test:cli', 'echo npm run test:cli'),
            original.replace('          GARDA_NODE_FOUNDATION_TEST_SHARDS:', '          UNRELATED_SHARD_MARKER:')]) {
            assert.notEqual(invalid, original);
            writeFile(workflow, invalid);
            const result = validateReleaseReadiness(repoRoot);
            assert.equal(result.passed, false);
            assert.equal(result.checks.find(check => check.area === 'ci')?.passed, false);
        }
        writeFile(workflow, original);
        const sentinel = path.join(repoRoot, 'selector-executed');
        writeFile(path.join(repoRoot, 'scripts/manual-workflow-authorization.cjs'),
            'require("node:fs").writeFileSync(' + JSON.stringify(sentinel) + ', "unsafe");\n');
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.checks.find(check => check.area === 'ci')?.passed, false);
        assert.equal(fs.existsSync(sentinel), false);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('reviewed CI evidence rejects executable scalar source drift while accepting CRLF', () => {
    const repoRoot = createReadinessFixture();
    try {
        const verifier = require(path.join(process.cwd(), 'scripts/manual-ci-evidence.cjs')) as {
            assertCiContract(root: string, checkScripts?: boolean): void;
        };
        const workflowPath = path.join(repoRoot, '.github/workflows/ci.yml');
        const original = fs.readFileSync(workflowPath, 'utf8');
        const anchor = '          set -euo pipefail\n';
        assert.ok(original.includes(anchor));
        verifier.assertCiContract(repoRoot, false);
        writeFile(workflowPath, original.replace(/\r?\n/gu, '\r\n'));
        verifier.assertCiContract(repoRoot, false);
        for (const inserted of [
            "          # ${{ fromJSON('\"\\nexit 0\\n\"') }}\n",
            '          # An unreviewed scalar comment\n',
            '\n',
            '          \n'
        ]) {
            const changed = original.replace(anchor, inserted + anchor);
            assert.notEqual(changed, original);
            writeFile(workflowPath, changed);
            assert.throws(() => verifier.assertCiContract(repoRoot, false), /reviewed manual complete-suite contract/);
        }
        writeFile(workflowPath, original.trimEnd());
        assert.throws(() => verifier.assertCiContract(repoRoot, false), /reviewed manual complete-suite contract/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('reviewed CI evidence rejects weakened npm scripts, missing permissions and symlink selector inputs', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const verifier = require(path.join(process.cwd(), 'scripts/manual-ci-evidence.cjs')) as { assertCiContract(root: string): void };
        verifier.assertCiContract(fixture.root);
        const packagePath = path.join(fixture.root, 'package.json');
        const original = fs.readFileSync(packagePath);
        const manifest = JSON.parse(original.toString());
        manifest.scripts.coverage = 'node --version';
        writeFile(packagePath, JSON.stringify(manifest));
        assert.throws(() => verifier.assertCiContract(fixture.root), /npm scripts differ/);
        fs.writeFileSync(packagePath, original);
        const unavailable = validateReleaseReadiness(fixture.root, fixture.request, {
            now: CANDIDATE_TEST_NOW, fetch: () => { throw new Error('Actions read permission unavailable (offline control).'); }
        });
        assert.equal(unavailable.candidate?.decision, 'NO_GO');
        assert.equal(unavailable.checks.find(check => check.area === 'candidate-suite')?.passed, false);
        const selector = path.join(fixture.root, 'scripts/manual-workflow-authorization.cjs');
        const target = selector + '.saved';
        fs.renameSync(selector, target);
        if (process.platform !== 'win32') {
            fs.symlinkSync(target, selector);
            assert.throws(() => verifier.assertCiContract(fixture.root), /bounded regular file/);
        } else {
            assert.throws(() => verifier.assertCiContract(fixture.root), /ENOENT/);
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness requires successful tool and release preparation in every CI matrix job', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        for (const job of fixture.jobs) {
            const release = String(job.name).startsWith('Release Validation /');
            if (!release && !String(job.name).startsWith('Unit Tests /')) continue;
            const original = job.steps as Record<string, unknown>[];
            const required = original.filter(step => String(step.name).startsWith('Install ripgrep for compact integration tests') ||
                ['Prepare embedded release bundle', 'Bootstrap embedded release bundle'].includes(String(step.name)));
            assert.equal(required.length, release ? 3 : 1);
            for (const step of required) {
                for (const replacement of [original.filter(item => item !== step),
                    original.map(item => item === step ? { ...item, conclusion: 'skipped' } : item)]) {
                    job.steps = replacement;
                    const result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
                    assert.equal(result.candidate?.decision, 'NO_GO', String(job.name) + ': ' + String(step.name));
                    assert.equal(result.checks.find(check => check.area === 'candidate-suite')?.passed, false);
                }
                job.steps = original;
            }
            if (release) {
                const otherPlatform = String(job.name).includes('ubuntu-latest') ? 'Windows' : 'Linux';
                job.steps = [...original, {
                    name: 'Install ripgrep for compact integration tests (' + otherPlatform + ')',
                    status: 'completed', conclusion: 'skipped'
                }];
                const result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
                assert.equal(result.candidate?.decision, 'GO', formatReleaseReadinessResult(result));
                job.steps = original;
            }
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness recursively checks manually decomposed DONE parents and ignores post-release feature parents', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const queuePath = path.join(fixture.root, 'TASK.md');
        const rows = [
            '| T-010 | DONE | P1 | workflow/release | Manually decomposed parent | codex | 2026-09-26 | balanced | Decomposition source: manual-operator; Child tasks: T-011, T-012. |',
            '| T-011 | DECOMPOSED | P1 | workflow/release | Nested parent | codex | 2026-09-26 | balanced | Decomposition source: manual-agent; Child tasks: T-013, T-014. |',
            '| T-012 | DONE | P1 | workflow/release | Sibling | codex | 2026-09-26 | balanced | |',
            '| T-013 | DONE | P1 | workflow/release | Leaf one | codex | 2026-09-26 | balanced | |',
            '| T-014 | TODO | P1 | workflow/release | Leaf two | codex | 2026-09-26 | balanced | |'
        ];
        writeFile(queuePath, candidateQueue(rows));
        let result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
        assert.match(formatReleaseReadinessResult(result), /Unfinished release task: T-014/);
        writeFile(queuePath, candidateQueue(rows).replace('T-014 | TODO', 'T-014 | DONE'));
        result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'GO', formatReleaseReadinessResult(result));
        writeFile(queuePath, candidateQueue(rows).replace('T-010 | DONE', 'T-010 | IN_PROGRESS'));
        result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
        writeFile(queuePath, candidateQueue(rows).replace('Child tasks: T-013, T-014.', 'Child tasks: T-010, T-014.'));
        result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
        assert.match(formatReleaseReadinessResult(result), /decomposition cycle/);
        writeFile(queuePath, candidateQueue(rows).replace('Child tasks: T-013, T-014.', 'Child tasks: T-013, T-099.'));
        result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects absent mandatory evidence, altered artifacts and mid-verification queue or candidate changes', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const evidence = path.join(fixture.request.candidateDirectory, 'security-evidence.json');
        const saved = fs.readFileSync(evidence);
        fs.unlinkSync(evidence);
        let result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
        assert.equal(result.checks.find(check => check.area === 'candidate-security')?.passed, false);
        fs.writeFileSync(evidence, saved);
        const queue = path.join(fixture.root, 'TASK.md');
        result = validateReleaseReadiness(fixture.root, fixture.request, {
            now: CANDIDATE_TEST_NOW, fetch: endpoint => {
                const payload = fixture.fetch(endpoint);
                if (endpoint.includes('/42')) fs.appendFileSync(queue, '\nOperator queue changed.\n');
                return payload;
            }
        });
        assert.equal(result.candidate?.decision, 'NO_GO');
        assert.equal(result.checks.find(check => check.area === 'candidate-recheck')?.passed, false);
        writeFile(queue, candidateQueue());
        result = validateReleaseReadiness(fixture.root, fixture.request, {
            now: CANDIDATE_TEST_NOW, fetch: endpoint => {
                const payload = fixture.fetch(endpoint);
                if (endpoint.includes('/42')) fs.appendFileSync(path.join(fixture.request.candidateDirectory, fixture.request.tarballName), 'altered');
                return payload;
            }
        });
        assert.equal(result.candidate?.decision, 'NO_GO');
        assert.equal(result.checks.find(check => check.area === 'candidate-recheck')?.passed, false);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness never exempts release blockers through incidental post-release notes', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const queue = path.join(fixture.root, 'TASK.md');
        const blocker = '| T-010 | TODO | P1 | release/proof | Required proof | codex | 2026-09-26 | balanced | Includes a post-release comparison after publication. |';
        writeFile(queue, candidateQueue([blocker]));
        let result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
        assert.match(formatReleaseReadinessResult(result), /Unfinished release task: T-010/);
        const parent = '| T-010 | DONE | P1 | workflow/release | Parent | codex | 2026-09-26 | balanced | Child tasks: T-011, T-100. |';
        const child = '| T-011 | TODO | P1 | workflow/proof | Required child | codex | 2026-09-26 | balanced | Post-release only; misleading pre-boundary label. |';
        writeFile(queue, candidateQueue([parent, child]));
        result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
        assert.match(formatReleaseReadinessResult(result), /Unfinished release task: T-011/);
        writeFile(queue, candidateQueue([parent, child]).replace('T-011 | TODO', 'T-011 | DONE'));
        result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'GO', formatReleaseReadinessResult(result));
        writeFile(queue, candidateQueue().replace('T-083 | DONE', 'T-083 | TODO').replace('Manual closeout authorized by operator.', 'Post-release only; mandatory policy.'));
        result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
        assert.match(formatReleaseReadinessResult(result), /Unfinished release task: T-083/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects missing explicit children including suffixes and range gaps', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const queue = path.join(fixture.root, 'TASK.md');
        const child = (id: string) => '| ' + id + ' | DONE | P1 | workflow/proof | Child | codex | 2026-09-26 | balanced | |';
        for (const [links, missing] of [
            ['Child tasks: T-011, T-012, T-099.', 'T-099'],
            ['Child tasks: T-011, T-012, T-099-F1.', 'T-099-F1'],
            ['Child range T-011 through T-014.', 'T-013']
        ]) {
            const parent = '| T-010 | DONE | P1 | workflow/release | Parent | codex | 2026-09-26 | balanced | Decomposition source: manual-operator; ' + links + ' |';
            writeFile(queue, candidateQueue([parent, child('T-011'), child('T-012'), child('T-014')]));
            const result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
            assert.equal(result.candidate?.decision, 'NO_GO');
            assert.match(formatReleaseReadinessResult(result), new RegExp('Missing release child task: ' + missing));
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness requires exact security and current or legacy provenance prerequisites', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        const queue = path.join(fixture.root, 'TASK.md');
        for (const missing of ['T-057', 'T-083']) {
            writeFile(queue, candidateQueue().split('\n').filter(line => !line.startsWith('| ' + missing + ' |')).join('\n'));
            const result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
            assert.equal(result.candidate?.decision, 'NO_GO');
            assert.match(formatReleaseReadinessResult(result), /Mandatory release prerequisite/);
        }
        writeFile(queue, candidateQueue().replace('T-083 | DONE', 'T-099 | DONE'));
        let result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
        writeFile(queue, candidateQueue().replace('T-083 | DONE', 'T-1027 | DONE'));
        result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'GO', formatReleaseReadinessResult(result));
        const duplicate = '| T-1027 | DONE | P1 | release/release-provenance-checksum-policy | Duplicate policy | codex | 2026-09-26 | balanced | |';
        writeFile(queue, candidateQueue([duplicate]));
        result = validateReleaseReadiness(fixture.root, fixture.request, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness CLI keeps static preflight separate and rejects incomplete or unsafe candidate arguments', () => {
    assert.equal(parseCandidateReadinessArgs([]), undefined);
    for (const args of [['--candidate'], ['--skip-evidence'], ['--candidate', 'relative', 'a'.repeat(40), 'v1.1.0', 'b'.repeat(64), 'pkg.tgz', 'fixture/garda', '41']]) {
        assert.throws(() => parseCandidateReadinessArgs(args));
    }
    const fixture = createCandidateReadinessFixture();
    try {
        const r = fixture.request;
        assert.deepEqual(parseCandidateReadinessArgs(['--candidate', r.candidateDirectory, r.commit, r.tag, r.tarballSha256, r.tarballName, r.repository, '41']), r);
        assert.match(formatReleaseReadinessResult(validateReleaseReadiness(fixture.root)), /ReleaseDecision: NOT_EVALUATED/);
        const result = validateReleaseReadiness(fixture.root, { ...r, commit: 'a'.repeat(40) }, { now: CANDIDATE_TEST_NOW, fetch: fixture.fetch });
        assert.equal(result.candidate?.decision, 'NO_GO');
        assert.equal(result.passed, false);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects matching fork CI and security evidence before live fetch', () => {
    const fixture = createCandidateReadinessFixture('foreign/garda-fork');
    try {
        let fetches = 0;
        const result = validateReleaseReadiness(fixture.root, fixture.request, {
            now: CANDIDATE_TEST_NOW, fetch: endpoint => { fetches += 1; return fixture.fetch(endpoint); }
        });
        assert.equal(result.candidate?.decision, 'NO_GO');
        assert.equal(result.checks.find(check => check.area === 'candidate-identity')?.passed, false);
        assert.match(formatReleaseReadinessResult(result), /authoritative verifier repository/);
        assert.equal(fetches, 0);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects unsafe tarball names at parser and artifact boundaries', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        for (const name of ['', '../outside.tgz', '/tmp/outside.tgz', 'C:\\outside.tgz', 'nested/pkg.tgz', 'nested\\pkg.tgz', 'bad\0.tgz']) {
            const request = { ...fixture.request, tarballName: name };
            const args = ['--candidate', request.candidateDirectory, request.commit, request.tag, request.tarballSha256, name, request.repository, '41'];
            assert.throws(() => parseCandidateReadinessArgs(args), /Unsafe release tarball name/);
            let fetches = 0;
            const result = validateReleaseReadiness(fixture.root, request, {
                now: CANDIDATE_TEST_NOW, fetch: endpoint => { fetches += 1; return fixture.fetch(endpoint); }
            });
            assert.equal(result.candidate?.decision, 'NO_GO', name);
            assert.equal(result.checks.find(check => check.area === 'candidate-identity')?.passed, false, name);
            assert.match(formatReleaseReadinessResult(result), /Unsafe release tarball name/);
            assert.equal(fetches, 0);
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness final recheck detects tracked checkout and security record mutations', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        for (const file of [path.join(fixture.root, 'SECURITY.md'), path.join(fixture.request.candidateDirectory, 'security-evidence.json')]) {
            const saved = fs.readFileSync(file);
            let mutated = false;
            const result = validateReleaseReadiness(fixture.root, fixture.request, {
                now: CANDIDATE_TEST_NOW, fetch: endpoint => {
                    const payload = fixture.fetch(endpoint);
                    if (!mutated && endpoint.endsWith('/42/jobs?filter=all&per_page=100')) {
                        fs.appendFileSync(file, '\n');
                        mutated = true;
                    }
                    return payload;
                }
            });
            assert.equal(mutated, true);
            assert.equal(result.checks.find(check => check.area === 'candidate-security')?.passed, true);
            assert.equal(result.checks.find(check => check.area === 'candidate-recheck')?.passed, false);
            assert.equal(result.candidate?.decision, 'NO_GO');
            fs.writeFileSync(file, saved);
        }
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness public CLI forwards candidate identity and reports GO or NO_GO with failure exit', t => {
    const fixture = createCandidateReadinessFixture();
    try {
        const build = require('../../../scripts/node-foundation/build') as { getRepoRoot(): string };
        t.mock.method(build, 'getRepoRoot', () => fixture.root);
        t.mock.timers.enable({ apis: ['Date'], now: CANDIDATE_TEST_NOW });
        const originalSpawn = childProcess.spawnSync;
        const endpoints: string[] = [];
        t.mock.method(require('node:child_process'), 'spawnSync', (command: string, args: string[], options: childProcess.SpawnSyncOptions) => {
            if (command !== 'gh') return originalSpawn(command, args, options);
            assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
            endpoints.push(args[3]);
            const payload = fixture.fetch(args[3], args.includes('--paginate'));
            return { status: 0, stdout: JSON.stringify(payload), stderr: '' };
        });
        const output: string[] = [];
        t.mock.method(console, 'log', (message?: unknown) => { output.push(String(message)); });
        let exitCode: string | number | null | undefined;
        t.mock.method(process, 'exit', (code?: string | number | null) => { exitCode = code; throw new Error('fixture process.exit'); });
        const request = fixture.request;
        const args = ['--candidate', request.candidateDirectory, request.commit, request.tag, request.tarballSha256, request.tarballName, request.repository, '41'];
        runReleaseValidationCli('release-readiness', args);
        assert.equal(exitCode, undefined);
        assert.deepEqual(endpoints, ['repos/' + request.repository + '/actions/runs/41',
            'repos/' + request.repository + '/actions/runs/41/jobs?filter=all&per_page=100',
            'repos/' + request.repository + '/actions/runs/42',
            'repos/' + request.repository + '/actions/runs/42/jobs?filter=all&per_page=100']);
        assert.match(output.join('\n'), /RELEASE_READINESS_OK/);
        assert.match(output.join('\n'), /ReleaseDecision: GO/);
        assert.match(output.join('\n'), /TaskQueueSha256: [a-f0-9]{64}/);
        output.length = 0;
        writeFile(path.join(fixture.root, 'TASK.md'), candidateQueue().replace('T-057 | DONE', 'T-057 | TODO'));
        assert.throws(() => runReleaseValidationCli('release-readiness', args), /fixture process\.exit/);
        assert.equal(exitCode, 1);
        assert.match(output.join('\n'), /RELEASE_READINESS_FAILED/);
        assert.match(output.join('\n'), /ReleaseDecision: NO_GO/);
        assert.match(output.join('\n'), /Unfinished release task: T-057/);
    } finally {
        t.mock.restoreAll();
        t.mock.timers.reset();
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('candidate readiness rejects malformed verifier repository metadata before evidence lookup', t => {
    const fixture = createCandidateReadinessFixture();
    try {
        const build = require('../../../scripts/node-foundation/build') as { getRepoRoot(): string };
        t.mock.method(build, 'getRepoRoot', () => fixture.root);
        const metadataPath = path.join(fixture.root, 'package.json');
        const original = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        for (const repository of [
            undefined,
            'https://github.com/' + CANDIDATE_TEST_REPOSITORY,
            { type: 'svn', url: original.repository.url },
            { type: 'git', url: 'https://example.invalid/' + CANDIDATE_TEST_REPOSITORY + '.git' },
            { type: 'git', url: original.repository.url + '?authority=caller' }
        ]) {
            const metadata = { ...original };
            if (repository === undefined) delete metadata.repository;
            else metadata.repository = repository;
            writeFile(metadataPath, JSON.stringify(metadata, null, 2));
            runGit(fixture.root, ['add', 'package.json']);
            commitFixture(fixture.root, 'fixture: invalid verifier repository');
            const head = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], {
                cwd: fixture.root, encoding: 'utf8', windowsHide: true
            });
            assert.equal(head.status, 0);
            const clean = childProcess.spawnSync('git', ['status', '--porcelain'], {
                cwd: fixture.root, encoding: 'utf8', windowsHide: true
            });
            assert.equal(clean.status, 0);
            assert.equal(clean.stdout.trim(), '');
            let fetches = 0;
            const result = validateReleaseReadiness(fixture.root, { ...fixture.request, commit: head.stdout.trim() }, {
                now: CANDIDATE_TEST_NOW, fetch: endpoint => { fetches += 1; return fixture.fetch(endpoint); }
            });
            assert.equal(result.candidate?.decision, 'NO_GO');
            const identity = result.checks.find(check => check.area === 'candidate-identity');
            assert.equal(identity?.passed, false);
            assert.match(identity?.details.join('\n') || '', /Invalid evidence object|Authoritative verifier repository metadata/);
            assert.equal(fetches, 0);
        }
    } finally {
        t.mock.restoreAll();
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});
