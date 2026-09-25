import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    formatReleaseReadinessResult,
    RELEASE_VALIDATION_COMMANDS,
    RELEASE_VALIDATION_COMMAND_HANDLERS,
    resolveReleaseValidationCommand,
    runReleaseValidationCli,
    validateReleaseReadiness
} from '../../../scripts/node-foundation/validate-release';

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
    return JSON.stringify({
        schemaVersion: 1,
        package: { name: 'garda-agent-orchestrator', version: '1.1.0' },
        metrics: {
            fileCount: 100,
            unpackedSizeBytes: 100000,
            lifecycleScripts: {
                postpack: 'node scripts/package-legacy-entrypoint-compat.cjs remove',
                prepack: 'npm run validate:clean-worktree && npm run build:publish-runtime && npm run validate:clean-worktree && node scripts/package-legacy-entrypoint-compat.cjs create'
            },
            riskSignals: {
                child_process: 1,
                exec: 1,
                fetch: 1,
                fs: 1,
                readFile: 1,
                writeFile: 1
            }
        },
        allowedGrowth: {
            fileCount: 10,
            unpackedSizeBytes: 262144,
            riskSignals: {
                child_process: 0,
                exec: 0,
                fetch: 0,
                fs: 0,
                readFile: 0,
                writeFile: 0
            }
        },
        rationale: 'Fixture compiled-only package baseline.'
    }, null, 2);
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
    return [
        'npm-audit:',
        '  steps:',
        '    - uses: actions/checkout@v7.0.0',
        '    - uses: actions/setup-node@v6',
        '    - run: npm audit --audit-level=high --no-fund',
        'osv-scan:',
        '  uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.0',
        '  with:',
        '    scan-args: |',
        '      --lockfile=package-lock.json'
    ].join('\n');
}

function buildSecretScanningWorkflow(
    transformJob: (job: string) => string = (job) => job
): string {
    const job = transformJob([
        'gitleaks:',
        '  name: Gitleaks',
        '  runs-on: ubuntu-latest',
        '  steps:',
        '    - uses: actions/checkout@v7.0.0',
        '      with:',
        '        fetch-depth: 0',
        '    - name: Install Gitleaks CLI',
        '      shell: bash',
        '      env:',
        "        GITLEAKS_VERSION: '8.30.1'",
        "        GITLEAKS_SHA256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'",
        '      run: |',
        '        set -euo pipefail',
        '        install_dir="$(mktemp -d "${RUNNER_TEMP}/gitleaks.XXXXXX")"',
        '        archive="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"',
        '        curl --fail --silent --show-error --location --retry 3 \\',
        '          "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}" \\',
        '          --output "${install_dir}/${archive}"',
        "        printf '%s  %s\\n' \"$GITLEAKS_SHA256\" \"${install_dir}/${archive}\" | sha256sum --check --strict",
        '        tar -xzf "${install_dir}/${archive}" -C "$install_dir" gitleaks',
        '        chmod +x "${install_dir}/gitleaks"',
        '        echo "$install_dir" >> "$GITHUB_PATH"',
        '    - name: Scan for secrets',
        '      shell: bash',
        '      run: gitleaks git --config .gitleaks.toml --redact --exit-code 1 .'
    ].join('\n'));
    return ['jobs:', ...job.split('\n').map((line) => `  ${line}`)].join('\n');
}

function buildSbomWorkflow(): string {
    return [
        'sbom:',
        '  steps:',
        '    - uses: actions/checkout@v7.0.0',
        '    - uses: actions/setup-node@v6',
        '    - run: npx --yes @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json',
        '    - uses: actions/upload-artifact@v7.0.1',
        '      with:',
        '        if-no-files-found: error'
    ].join('\n');
}

function buildPublishWorkflow(): string {
    return [
        'name: Publish',
        'on:',
        '  push:',
        '    tags:',
        "      - 'v*'",
        'permissions:',
        '  actions: read',
        '  contents: read',
        'env:',
        "  NODE_VERSION: '24'",
        'jobs:',
        '  validate:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v7.0.0',
        '        with:',
        '          fetch-depth: 0',
        '      - uses: actions/setup-node@v6',
        '        with:',
        '          node-version: ${{ env.NODE_VERSION }}',
        '          package-manager-cache: false',
        '      - run: |',
        '          set -euo pipefail',
        '          if [[ "${{ github.run_attempt }}" != "1" ]]; then',
        '            exit 1',
        '          fi',
        '          if [[ "${GITHUB_REF_TYPE}" != "tag" || "${GITHUB_REF_NAME}" != v* ]]; then',
        '            exit 1',
        '          fi',
        '          TAG_VERSION="${GITHUB_REF_NAME#v}"',
        '          PACKAGE_VERSION="$(node -p "require(\'./package.json\').version")"',
        '          LOCK_VERSION="$(node -p "require(\'./package-lock.json\').version")"',
        '          LOCK_ROOT_VERSION="$(node -p "require(\'./package-lock.json\').packages[\'\'].version")"',
        '          VERSION_FILE="$(node -e "process.stdout.write(require(\'node:fs\').readFileSync(\'VERSION\', \'utf8\').trim())")"',
        '          if [[ "${TAG_VERSION}" != "${PACKAGE_VERSION}" || "${TAG_VERSION}" != "${LOCK_VERSION}" || "${TAG_VERSION}" != "${LOCK_ROOT_VERSION}" || "${TAG_VERSION}" != "${VERSION_FILE}" ]]; then',
        '            exit 1',
        '          fi',
        '      - name: Reject previously used release tags',
        '        shell: bash',
        '        run: |',
        '          set -euo pipefail',
        '',
        '          RUN_HISTORY_PATH="${RUNNER_TEMP}/publish-workflow-runs.json"',
        '          GH_TOKEN="${{ github.token }}" gh api --method GET \\',
        '            "repos/${GITHUB_REPOSITORY}/actions/workflows/publish.yml/runs" \\',
        '            -f event=push \\',
        '            -f branch="${GITHUB_REF_NAME}" \\',
        '            -f per_page=100 \\',
        '            --paginate \\',
        '            --slurp > "${RUN_HISTORY_PATH}"',
        '          node -e \'',
        '            const fs = require("node:fs");',
        '            const pages = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));',
        '            const currentRunId = process.env.GITHUB_RUN_ID;',
        '            if (!Array.isArray(pages) || !currentRunId) {',
        '              throw new Error("GitHub workflow-run history is unavailable.");',
        '            }',
        '            const priorRuns = pages',
        '              .flatMap((page) => Array.isArray(page.workflow_runs) ? page.workflow_runs : [])',
        '              .filter((run) => String(run.id) !== currentRunId);',
        '            if (priorRuns.length > 0) {',
        '              console.error(`Release tag ${process.env.GITHUB_REF_NAME} already triggered workflow run(s): ${priorRuns.map((run) => run.id).join(", ")}`);',
        '              process.exit(1);',
        '            }',
        '          \' "${RUN_HISTORY_PATH}"',
        '          git update-ref -d "refs/tags/${GITHUB_REF_NAME}"',
        '      - run: npm ci --no-fund --no-audit',
        '      - run: npm run release:preflight',
        '      - run: |',
        '          set -euo pipefail',
        '          npm pack --dry-run | tee "$RUNNER_TEMP/npm-pack-dry-run.txt"',
        '      - uses: actions/upload-artifact@v7.0.1',
        '        with:',
        '          path: ${{ runner.temp }}/npm-pack-dry-run.txt',
        '          if-no-files-found: error',
        '  publish:',
        '    needs: validate',
        '    runs-on: ubuntu-latest',
        '    environment: npm-release',
        '    permissions:',
        '      contents: read',
        '      id-token: write',
        '    steps:',
        '      - uses: actions/checkout@v7.0.0',
        '        with:',
        '          fetch-depth: 0',
        '      - uses: actions/setup-node@v6',
        '        with:',
        '          node-version: ${{ env.NODE_VERSION }}',
        '          registry-url: https://registry.npmjs.org',
        '          package-manager-cache: false',
        '      - run: npm ci --no-fund --no-audit',
        '      - run: npm install -g npm@^11.15.0',
        '      - run: |',
        '          set -euo pipefail',
        '          if [[ "${{ github.run_attempt }}" != "1" ]]; then',
        '            exit 1',
        '          fi',
        '          TAG_VERSION="${GITHUB_REF_NAME#v}"',
        '          PACKAGE_NAME="$(node -p "require(\'./package.json\').name")"',
        '          PACKAGE_VERSION="$(node -p "require(\'./package.json\').version")"',
        '          LOCK_VERSION="$(node -p "require(\'./package-lock.json\').version")"',
        '          LOCK_ROOT_VERSION="$(node -p "require(\'./package-lock.json\').packages[\'\'].version")"',
        '          VERSION_FILE="$(node -e "process.stdout.write(require(\'node:fs\').readFileSync(\'VERSION\', \'utf8\').trim())")"',
        '          if [[ "${GITHUB_REF_TYPE}" != "tag" || "${GITHUB_REF_NAME}" != v* ]]; then',
        '            exit 1',
        '          fi',
        '          if [[ "${PACKAGE_NAME}" != "garda-agent-orchestrator" ]]; then',
        '            exit 1',
        '          fi',
        '          if [[ "${TAG_VERSION}" != "${PACKAGE_VERSION}" || "${TAG_VERSION}" != "${LOCK_VERSION}" || "${TAG_VERSION}" != "${LOCK_ROOT_VERSION}" || "${TAG_VERSION}" != "${VERSION_FILE}" ]]; then',
        '            exit 1',
        '          fi',
        '          NPM_VERSION="$(npm --version)"',
        '          node -e "const version = process.argv[1]; const [major, minor] = version.split(\'.\').map(Number); if (!Number.isFinite(major) || !Number.isFinite(minor) || major < 11 || (major === 11 && minor < 15)) { throw new Error(\'npm CLI 11.15.0+ is required for npm staged publishing.\'); }" "${NPM_VERSION}"',
        '          git update-ref -d "refs/tags/${GITHUB_REF_NAME}"',
        '      - run: npm run release:preflight',
        '      - run: npm stage publish'
    ].join('\n');
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
            'Tag-driven npm staged publishing',
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
        buildCiWorkflow()
    );
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
        assert.match(output, /trusted-publish-workflow: npm Trusted Publishing workflow is tag-driven/);
        assert.match(output, /trusted-publish-docs: release docs document the tag-driven npm Trusted Publishing operator path/);
        assert.match(output, /Release-security baseline: readiness labels npm audit and gitleaks as blocking/);
        assert.match(output, /Trusted Publishing path: pushing the matching v\* tag runs/);
        assert.doesNotMatch(output, /Security\/audit proof:/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

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
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'secret-scanning.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                '    - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
                '    - "uses": "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0" # v7.0.0'
            )
        );
        const result = validateReleaseReadiness(repoRoot);
        assert.equal(result.passed, true, formatReleaseReadinessResult(result));
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
        assert.match(output, /release-package-surface-baseline\.json\.allowedGrowth must be an object/u);
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

test('release readiness fails when tagged publish jobs allow workflow reruns', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replaceAll(
                [
                    '          if [[ "${{ github.run_attempt }}" != "1" ]]; then',
                    '            exit 1',
                    '          fi',
                    ''
                ].join('\n'),
                ''
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /validate job rejects repeated workflow attempts=false/u);
        assert.match(output, /publish job rejects repeated workflow attempts=false/u);
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
                '          GH_TOKEN="${{ github.token }}" gh api --method GET \\\n',
                '          echo "workflow history omitted"\n'
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /validate job rejects release tags with a prior workflow run=false/u);
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
                /[ ]{6}- name: Reject previously used release tags\n[\s\S]+?(?=[ ]{6}- run: npm ci --no-fund --no-audit)/u,
                [
                    '      - name: Reject previously used release tags',
                    '        shell: bash',
                    '        run: |',
                    '          : \'GH_TOKEN="${{ github.token }}" gh api --method GET\'',
                    '          : \'actions/workflows/publish.yml/runs\'',
                    '          : \'-f event=push\'',
                    '          : \'-f branch="${GITHUB_REF_NAME}"\'',
                    '          : \'--paginate\'',
                    '          : \'--slurp\'',
                    '          : \'GITHUB_RUN_ID\'',
                    '          : \'process.exit(1)\'',
                    '          git update-ref -d "refs/tags/${GITHUB_REF_NAME}"',
                    ''
                ].join('\n')
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /validate job rejects release tags with a prior workflow run=false/u);
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
                '        with:\n          fetch-depth: 0\n',
                ''
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
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                '- run: npm stage publish',
                [
                    '- run: npm stage publish',
                    '        env:',
                    '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}'
                ].join('\n')
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish workflow avoids npm tokens, --provenance override, and self-hosted runners=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish workflow allows manual dispatch', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                'on:\n  push:',
                'on:\n  workflow_dispatch:\n  push:'
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish\.yml is v\*-tag driven without manual dispatch=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish tag trigger is not under push', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                'on:\n  push:\n    tags:',
                'on:\n  release:\n    tags:'
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish\.yml is v\*-tag driven without manual dispatch=false/);
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
                /[ ]{6}- run: \|\n[\s\S]+?(?=[ ]{6}- name: Reject previously used release tags)/u,
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
                /[ ]{6}- run: \|\n[\s\S]+?(?=[ ]{6}- name: Reject previously used release tags)/u,
                [
                    '      - run: |',
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

test('release readiness fails when trusted publish dry-run artifact is written inside checkout', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8')
                .replace('npm pack --dry-run | tee "$RUNNER_TEMP/npm-pack-dry-run.txt"', 'npm pack --dry-run | tee npm-pack-dry-run.txt')
                .replace('path: ${{ runner.temp }}/npm-pack-dry-run.txt', 'path: npm-pack-dry-run.txt')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /validate job records npm pack dry-run output outside the checkout=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish dry-run pipeline omits pipefail', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                '      - run: |\n          set -euo pipefail\n          npm pack --dry-run | tee "$RUNNER_TEMP/npm-pack-dry-run.txt"',
                '      - run: npm pack --dry-run | tee "$RUNNER_TEMP/npm-pack-dry-run.txt"'
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /validate job records npm pack dry-run output outside the checkout=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

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
        assert.match(output, /publish job is npm-release environment bound and uses id-token OIDC npm stage publish=false/);
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
        assert.match(output, /publish job is npm-release environment bound and uses id-token OIDC npm stage publish=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish sanity checks only echo markers', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                /[ ]{6}- run: npm ci --no-fund --no-audit\n[ ]{6}- run: npm install -g npm@\^11\.15\.0\n[ ]{6}- run: \|\n(?:[ ]{10}.+\n)+?[ ]{6}- run: npm run release:preflight/u,
                [
                    '      - run: npm ci --no-fund --no-audit',
                    '      - run: npm install -g npm@^11.15.0',
                    '      - run: |',
                    '          echo "${GITHUB_REF_NAME}"',
                    '          echo "garda-agent-orchestrator"',
                    '          echo "npm CLI 11.15.0+"',
                    '      - run: npm run release:preflight'
                ].join('\n')
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish job has fail-closed package and npm CLI sanity guard=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish sanity guard markers are inside heredoc text', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                /[ ]{6}- run: npm ci --no-fund --no-audit\n[ ]{6}- run: npm install -g npm@\^11\.15\.0\n[ ]{6}- run: \|\n(?:[ ]{10}.+\n)+?[ ]{6}- run: npm run release:preflight/u,
                [
                    '      - run: npm ci --no-fund --no-audit',
                    '      - run: npm install -g npm@^11.15.0',
                    '      - run: |',
                    "          cat <<'EOF'",
                    '          set -euo pipefail',
                    '          GITHUB_REF_TYPE',
                    '          GITHUB_REF_NAME',
                    '          TAG_VERSION="${GITHUB_REF_NAME#v}"',
                    '          PACKAGE_NAME="$(node -p "require(\'./package.json\').name")"',
                    '          PACKAGE_VERSION="$(node -p "require(\'./package.json\').version")"',
                    '          LOCK_VERSION="$(node -p "require(\'./package-lock.json\').version")"',
                    '          LOCK_ROOT_VERSION="$(node -p "require(\'./package-lock.json\').packages[\'\'].version")"',
                    '          VERSION_FILE="$(node -e "process.stdout.write(require(\'node:fs\').readFileSync(\'VERSION\', \'utf8\').trim())")"',
                    '          ${PACKAGE_NAME}" != "garda-agent-orchestrator"',
                    '          ${TAG_VERSION}" != "${PACKAGE_VERSION}',
                    '          ${TAG_VERSION}" != "${LOCK_VERSION}',
                    '          ${TAG_VERSION}" != "${LOCK_ROOT_VERSION}',
                    '          ${TAG_VERSION}" != "${VERSION_FILE}',
                    '          NPM_VERSION="$(npm --version)"',
                    '          npm CLI 11.15.0+',
                    '          major < 11',
                    '          minor < 15',
                    '          EOF',
                    '      - run: npm run release:preflight'
                ].join('\n')
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish job has fail-closed package and npm CLI sanity guard=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish workflow uses direct npm publish', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace('      - run: npm stage publish', '      - run: npm publish')
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish job is npm-release environment bound and uses id-token OIDC npm stage publish=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness fails when trusted publish command is only heredoc text', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replace(
                '      - run: npm stage publish',
                [
                    '      - run: |',
                    "          cat <<'EOF'",
                    '          npm stage publish',
                    '          EOF'
                ].join('\n')
            )
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, false);
        assert.match(output, /publish job is npm-release environment bound and uses id-token OIDC npm stage publish=false/);
        assert.ok(result.violations.some(v => v.startsWith('trusted-publish-workflow:')));
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
                '    - run: npx --yes @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json',
                '    - uses: actions/upload-artifact@v7.0.1',
                '      with:',
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
                '    - run: npx --yes @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json',
                '    - uses: actions/upload-artifact@v7.0.1',
                '      with:',
                '        name: sbom-cyclonedx',
                '    - name: Unrelated upload policy',
                '      with:',
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
        assert.match(output, /ReleaseChecklistItems: 27/);
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

test('release readiness accepts multiline CI lifecycle smoke run steps', () => {
    const repoRoot = createReadinessFixture();
    try {
        writeFile(
            path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
            buildCiWorkflow({
                smokeSteps: [
                    '    - name: lifecycle smoke',
                    '      run: |',
                    '        $CLI setup --target-root "$SMOKE_DIR"',
                    '        $CLI update git --target-root "$SMOKE_DIR"',
                    '        $CLI doctor --target-root "$SMOKE_DIR"',
                    '        $CLI uninstall --target-root "$SMOKE_DIR"'
                ].join('\n')
            })
        );

        const result = validateReleaseReadiness(repoRoot);
        const output = formatReleaseReadinessResult(result);

        assert.equal(result.passed, true, output);
        assert.match(output, /RELEASE_READINESS_OK/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('release readiness accepts multiline CI lifecycle smoke run steps with chomping indicators', () => {
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

        assert.equal(result.passed, true, output);
        assert.match(output, /RELEASE_READINESS_OK/);
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
        assert.match(output, /test-cli present\+sharded=false/);
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
