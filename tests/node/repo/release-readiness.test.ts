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
    return fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'sbom.yml'), 'utf8');
}

function buildPublishWorkflow(): string {
    return [
        '# Tag-driven npm release workflow for Garda Agent Orchestrator.',
        '# The publish job uses npm Trusted Publishing/OIDC to stage the package.',
        '# The public release still requires npm staged approval with maintainer 2FA.',
        'name: Publish',
        '',
        'on:',
        '  push:',
        '    tags:',
        '      - \'v*\'',
        '',
        'concurrency:',
        '  group: publish-${{ github.ref }}',
        '  cancel-in-progress: false',
        '',
        'permissions:',
        '  actions: read',
        '  contents: read',
        '',
        'env:',
        '  NODE_VERSION: \'24\'',
        '',
        'jobs:',
        '  validate:',
        '    name: Validate release package',
        '    runs-on: ubuntu-latest',
        '    outputs:',
        '      tarball_sha256: ${{ steps.pack.outputs.tarball_sha256 }}',
        '      tarball_name: ${{ steps.pack.outputs.tarball_name }}',
        '    steps:',
        '      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
        '        with:',
        '          fetch-depth: 0',
        '',
        '      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0',
        '        with:',
        '          node-version: ${{ env.NODE_VERSION }}',
        '          package-manager-cache: false',
        '',
        '      - name: Validate tag and package version',
        '        shell: bash',
        '        run: |',
        '          set -euo pipefail',
        '',
        '          if [[ "${{ github.run_attempt }}" != "1" ]]; then',
        '            echo "Release workflow reruns are rejected; prepare a new version and tag instead." >&2',
        '            exit 1',
        '          fi',
        '          if [[ "${GITHUB_REF_TYPE}" != "tag" || "${GITHUB_REF_NAME}" != v* ]]; then',
        '            echo "Publish workflow must run from a v* tag." >&2',
        '            exit 1',
        '          fi',
        '',
        '          TAG_VERSION="${GITHUB_REF_NAME#v}"',
        '          PACKAGE_VERSION="$(node -p "require(\'./package.json\').version")"',
        '          LOCK_VERSION="$(node -p "require(\'./package-lock.json\').version")"',
        '          LOCK_ROOT_VERSION="$(node -p "require(\'./package-lock.json\').packages[\'\'].version")"',
        '          VERSION_FILE="$(node -e "process.stdout.write(require(\'node:fs\').readFileSync(\'VERSION\', \'utf8\').trim())")"',
        '',
        '          if [[ "${TAG_VERSION}" != "${PACKAGE_VERSION}" || "${TAG_VERSION}" != "${LOCK_VERSION}" || "${TAG_VERSION}" != "${LOCK_ROOT_VERSION}" || "${TAG_VERSION}" != "${VERSION_FILE}" ]]; then',
        '            echo "Release tag v${TAG_VERSION} does not match package/version metadata." >&2',
        '            echo "package.json=${PACKAGE_VERSION} package-lock=${LOCK_VERSION} package-lock-root=${LOCK_ROOT_VERSION} VERSION=${VERSION_FILE}" >&2',
        '            exit 1',
        '          fi',
        '',
        '          echo "Release tag v${TAG_VERSION} matches package.json, package-lock.json, package-lock root, and VERSION."',
        '',
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
        '',
        '      - name: Require successful CI for this release commit',
        '        shell: bash',
        '        run: |',
        '          set -euo pipefail',
        '          test "$(git rev-parse HEAD)" = "${GITHUB_SHA}"',
        '          CI_RUNS_PATH="${RUNNER_TEMP}/release-ci-runs.json"',
        '          GH_TOKEN="${{ github.token }}" gh api --method GET \\',
        '            "repos/${GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs" \\',
        '            -f head_sha="${GITHUB_SHA}" -f event=push -f status=completed -f per_page=100 > "${CI_RUNS_PATH}"',
        '          node scripts/release-candidate.cjs verify-ci "${CI_RUNS_PATH}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
        '',
        '      - name: Install dependencies',
        '        run: npm ci --no-fund --no-audit',
        '',
        '      - name: Pin release npm CLI',
        '        run: |',
        '          set -euo pipefail',
        '          npm install -g npm@11.15.0',
        '          test "$(npm --version)" = "11.15.0"',
        '',
        '      - name: Run local release proof',
        '        run: npm run release:preflight',
        '',
        '      - name: Pack and attest release candidate',
        '        id: pack',
        '        shell: bash',
        '        run: |',
        '          set -euo pipefail',
        '          CANDIDATE_DIR="${RUNNER_TEMP}/release-candidate"',
        '          mkdir -p "${CANDIDATE_DIR}"',
        '          npm pack --json --pack-destination "${CANDIDATE_DIR}" > "${CANDIDATE_DIR}/pack-report.json"',
        '          PACKAGE_NAME="$(node -p "require(\'./package.json\').name")"',
        '          PACKAGE_VERSION="$(node -p "require(\'./package.json\').version")"',
        '          node scripts/release-candidate.cjs create \\',
        '            "${CANDIDATE_DIR}/pack-report.json" "${CANDIDATE_DIR}" \\',
        '            "${GITHUB_SHA}" "${GITHUB_REF_NAME}" "${PACKAGE_NAME}" "${PACKAGE_VERSION}" "${GITHUB_OUTPUT}"',
        '',
        '          TARBALL_NAME="$(node -p "require(process.argv[1]).tarball_name" "${CANDIDATE_DIR}/candidate-manifest.json")"',
        '          TARBALL_SHA256="$(node -p "require(process.argv[1]).tarball_sha256" "${CANDIDATE_DIR}/candidate-manifest.json")"',
        '          GARDA_RELEASE_CANDIDATE_PATH="${CANDIDATE_DIR}/${TARBALL_NAME}" npm run test:packaging',
        '          node scripts/release-candidate.cjs verify "${CANDIDATE_DIR}" "${GITHUB_SHA}" "${GITHUB_REF_NAME}" "${TARBALL_SHA256}" "${TARBALL_NAME}"',
        '',
        '      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
        '        with:',
        '          name: release-candidate-${{ github.sha }}',
        '          path: ${{ runner.temp }}/release-candidate/',
        '          if-no-files-found: error',
        '          retention-days: 7',
        '',
        '  publish:',
        '    name: Stage package on npm',
        '    runs-on: ubuntu-latest',
        '    needs: validate',
        '    environment: npm-release',
        '    permissions:',
        '      actions: read',
        '      contents: read',
        '      id-token: write',
        '    steps:',
        '      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0',
        '        with:',
        '          fetch-depth: 0',
        '',
        '      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0',
        '        with:',
        '          node-version: ${{ env.NODE_VERSION }}',
        '          registry-url: https://registry.npmjs.org',
        '          package-manager-cache: false',
        '',
        '      - name: Pin release npm CLI',
        '        run: |',
        '          set -euo pipefail',
        '          npm install -g npm@11.15.0',
        '          test "$(npm --version)" = "11.15.0"',
        '',
        '      - name: Final publish sanity checks',
        '        shell: bash',
        '        run: |',
        '          set -euo pipefail',
        '',
        '          if [[ "${{ github.run_attempt }}" != "1" ]]; then',
        '            echo "Release workflow reruns are rejected; prepare a new version and tag instead." >&2',
        '            exit 1',
        '          fi',
        '          TAG_VERSION="${GITHUB_REF_NAME#v}"',
        '          PACKAGE_NAME="$(node -p "require(\'./package.json\').name")"',
        '          PACKAGE_VERSION="$(node -p "require(\'./package.json\').version")"',
        '          LOCK_VERSION="$(node -p "require(\'./package-lock.json\').version")"',
        '          LOCK_ROOT_VERSION="$(node -p "require(\'./package-lock.json\').packages[\'\'].version")"',
        '          VERSION_FILE="$(node -e "process.stdout.write(require(\'node:fs\').readFileSync(\'VERSION\', \'utf8\').trim())")"',
        '',
        '          if [[ "${GITHUB_REF_TYPE}" != "tag" || "${GITHUB_REF_NAME}" != v* ]]; then',
        '            echo "Publish job must run from a v* tag." >&2',
        '            exit 1',
        '          fi',
        '          if [[ "${PACKAGE_NAME}" != "garda-agent-orchestrator" ]]; then',
        '            echo "Unexpected package name: ${PACKAGE_NAME}" >&2',
        '            exit 1',
        '          fi',
        '          if [[ "${TAG_VERSION}" != "${PACKAGE_VERSION}" || "${TAG_VERSION}" != "${LOCK_VERSION}" || "${TAG_VERSION}" != "${LOCK_ROOT_VERSION}" || "${TAG_VERSION}" != "${VERSION_FILE}" ]]; then',
        '            echo "Release tag v${TAG_VERSION} does not match package/version metadata." >&2',
        '            exit 1',
        '          fi',
        '',
        '          node --version',
        '          NPM_VERSION="$(npm --version)"',
        '          echo "npm ${NPM_VERSION}"',
        '          test "${NPM_VERSION}" = "11.15.0"',
        '          git update-ref -d "refs/tags/${GITHUB_REF_NAME}"',
        '',
        '      - name: Download validated release candidate',
        '        shell: bash',
        '        env:',
        '          GH_TOKEN: ${{ github.token }}',
        '        run: |',
        '          set -euo pipefail',
        '          gh run download "${GITHUB_RUN_ID}" --name "release-candidate-${GITHUB_SHA}" --dir "${RUNNER_TEMP}/release-candidate"',
        '',
        '      - name: Verify downloaded candidate',
        '        shell: bash',
        '        env:',
        '          EXPECTED_SHA256: ${{ needs.validate.outputs.tarball_sha256 }}',
        '          EXPECTED_NAME: ${{ needs.validate.outputs.tarball_name }}',
        '        run: |',
        '          set -euo pipefail',
        '          node scripts/release-candidate.cjs verify \\',
        '            "${RUNNER_TEMP}/release-candidate" "${GITHUB_SHA}" "${GITHUB_REF_NAME}" \\',
        '            "${EXPECTED_SHA256}" "${EXPECTED_NAME}"',
        '',
        '      - name: Stage the validated tarball with npm Trusted Publishing',
        '        shell: bash',
        '        env:',
        '          EXPECTED_NAME: ${{ needs.validate.outputs.tarball_name }}',
        '        run: |',
        '          set -euo pipefail',
        '          npm stage publish "${RUNNER_TEMP}/release-candidate/${EXPECTED_NAME}"',
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

test('release readiness fails when tagged publish jobs allow workflow reruns', () => {
    const repoRoot = createReadinessFixture();
    try {
        const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish.yml');
        writeFile(
            workflowPath,
            fs.readFileSync(workflowPath, 'utf8').replaceAll(
                [
                    '          if [[ "${{ github.run_attempt }}" != "1" ]]; then',
                    '            echo "Release workflow reruns are rejected; prepare a new version and tag instead." >&2',
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
                /[ ]{6}- name: Reject previously used release tags\n[\s\S]+?(?=[ ]{6}- name: Install dependencies)/u,
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
                /[ ]{6}- name: Validate tag and package version\n[\s\S]+?(?=[ ]{6}- name: Reject previously used release tags)/u,
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
                /[ ]{6}- name: Validate tag and package version\n[\s\S]+?(?=[ ]{6}- name: Reject previously used release tags)/u,
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
            .replace('          node scripts/release-candidate.cjs verify-ci "${CI_RUNS_PATH}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
                '          echo node scripts/release-candidate.cjs verify-ci "${CI_RUNS_PATH}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"');
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
    ['a masked CI proof', '          node scripts/release-candidate.cjs verify-ci "${CI_RUNS_PATH}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
        '          node scripts/release-candidate.cjs verify-ci "${CI_RUNS_PATH}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}" || true'],
    ['a masked candidate verification', '          node scripts/release-candidate.cjs verify "${CANDIDATE_DIR}" "${GITHUB_SHA}" "${GITHUB_REF_NAME}" "${TARBALL_SHA256}" "${TARBALL_NAME}"',
        '          node scripts/release-candidate.cjs verify "${CANDIDATE_DIR}" "${GITHUB_SHA}" "${GITHUB_REF_NAME}" "${TARBALL_SHA256}" "${TARBALL_NAME}" || true'],
    ['negated CI proof', '          node scripts/release-candidate.cjs verify-ci "${CI_RUNS_PATH}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
        '          ! node scripts/release-candidate.cjs verify-ci "${CI_RUNS_PATH}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"'],
    ['conditional candidate verification', '          node scripts/release-candidate.cjs verify "${CANDIDATE_DIR}" "${GITHUB_SHA}" "${GITHUB_REF_NAME}" "${TARBALL_SHA256}" "${TARBALL_NAME}"',
        '          if node scripts/release-candidate.cjs verify "${CANDIDATE_DIR}" "${GITHUB_SHA}" "${GITHUB_REF_NAME}" "${TARBALL_SHA256}" "${TARBALL_NAME}"; then\n            true\n          fi'],
    ['conditional CI proof with and-list', '          node scripts/release-candidate.cjs verify-ci "${CI_RUNS_PATH}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
        '          true && node scripts/release-candidate.cjs verify-ci "${CI_RUNS_PATH}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"'],
    ['disabled strict shell error handling', '          CANDIDATE_DIR="${RUNNER_TEMP}/release-candidate"',
        '          set +e\\n          CANDIDATE_DIR="${RUNNER_TEMP}/release-candidate"'],
    ['CI proof hidden in a shell assignment', '          node scripts/release-candidate.cjs verify-ci "${CI_RUNS_PATH}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
        '          PROOF="node scripts/release-candidate.cjs verify-ci ${CI_RUNS_PATH} ${GITHUB_SHA} ${GITHUB_REPOSITORY}"'],
    ['CI proof hidden in a shell no-op', '          node scripts/release-candidate.cjs verify-ci "${CI_RUNS_PATH}" "${GITHUB_SHA}" "${GITHUB_REPOSITORY}"',
        '          : "node scripts/release-candidate.cjs verify-ci ${CI_RUNS_PATH} ${GITHUB_SHA} ${GITHUB_REPOSITORY}"'],
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

const CANDIDATE_TEST_NOW = new Date('2026-09-26T10:00:00.000Z');
const CANDIDATE_TEST_REPOSITORY = 'Garda-Studio/garda-agent-orchestrator';

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
    const names: [string, string[]][] = [];
    for (const node of ['22.13.0', '24']) {
        for (const [name, step] of [
            ['Static Checks', 'Run typecheck'], ['Unit Tests', 'Run unit tests'],
            ['Gate Tests', 'Run gate tests (parallel shards)'], ['CLI Tests', 'Run CLI tests (parallel shards)'],
            ['Lifecycle Tests', 'Run lifecycle tests'], ['Binary Tests', 'Run binary tests']
        ]) names.push([name + ' / Node ' + node, name === 'Static Checks' ? [step, 'Run lint'] : name === 'Unit Tests'
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
        steps: ['Install dependencies', ...steps].map(step => ({ name: step, status: 'completed', conclusion: 'success' }))
    }));
}

function createCandidateReadinessFixture(repository = CANDIDATE_TEST_REPOSITORY): {
    root: string; request: CandidateReadinessRequest; fetch: GithubEvidenceFetcher; ci: Record<string, unknown>;
    jobs: Record<string, unknown>[];
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
        for (const file of ['release-candidate.cjs', 'release-security-evidence.cjs', 'validate-workflow-references.cjs']) {
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
            path: '.github/workflows/ci.yml', head_branch: 'dev', event: 'push', status: 'completed', conclusion: 'success',
            run_attempt: 1, run_started_at: '2026-09-26T09:00:00Z', updated_at: '2026-09-26T09:30:00Z' };
        const jobs = ciJobFixture(commit);
        const securityRun = { ...ci, id: 42, path: '.github/workflows/security.yml' };
        const securityJobs = ['npm audit', 'OSV Vulnerability Scan / scan'].map((name, index) => ({
            id: 501 + index, run_id: 42, head_sha: commit, name, status: 'completed', conclusion: 'success',
            started_at: ci.run_started_at, completed_at: ci.updated_at,
            steps: (index === 0 ? ['Pin release audit npm CLI', 'Install dependencies', 'Audit dependencies'] :
                ['Run scanner', 'Run osv-scanner-reporter']).map(step => ({ name: step, status: 'completed', conclusion: 'success' }))
        }));
        const fetch: GithubEvidenceFetcher = endpoint => {
            const expected = [41, 42].flatMap(id => ['repos/' + repository + '/actions/runs/' + id, 'repos/' + repository + '/actions/runs/' + id + '/jobs?per_page=100']);
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
        return { root, request, fetch, ci, jobs };
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

test('candidate readiness rejects foreign, stale, skipped, empty and replayed suite evidence', () => {
    const fixture = createCandidateReadinessFixture();
    try {
        for (const mutation of [
            { head_sha: 'a'.repeat(40) }, { conclusion: 'skipped' }, { updated_at: '2026-09-24T09:30:00Z' },
            { repository: { full_name: 'foreign/repo' } }, { run_attempt: 2 }
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
                    if (!mutated && endpoint.endsWith('/42/jobs?per_page=100')) {
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
        assert.deepEqual(endpoints, [41, 42].flatMap(id => ['repos/' + request.repository + '/actions/runs/' + id, 'repos/' + request.repository + '/actions/runs/' + id + '/jobs?per_page=100']));
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
