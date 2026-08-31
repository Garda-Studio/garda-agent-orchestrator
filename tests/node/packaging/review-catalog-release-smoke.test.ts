import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { handleReviewCatalog } from '../../../src/cli/commands/review-catalog-command';
import { BUILT_IN_REVIEW_TYPE_IDS } from '../../../src/core/review-catalog';
import { analyzeReviewCatalogMigrationParity } from '../../../src/core/review-catalog-migration';
import type { ReviewCapabilitiesConfigMap } from '../../../src/core/review-capabilities';
import { runInit } from '../../../src/materialization/init';
import { buildReviewCatalogTab } from '../../../src/reports/report-data/review-catalog-tab';

const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    name: string;
    version: string;
    files: string[];
};
const CUSTOM_REVIEW_ID = 'library-compatibility';
const NPM_COMMAND_TIMEOUT_MS = 120_000;

type CommandResult = Record<string, any>;

interface NpmPackReport {
    filename: string;
    files: Array<{ path: string }>;
}

function readJson(filePath: string): Record<string, any> {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
}

function writeJson(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function quoteWindowsArgument(argument: string): string {
    if (!argument || !/[ \t"]/u.test(argument)) {
        return argument;
    }
    return `"${argument.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
}

function spawnNpm(args: string[], cwd: string): childProcess.SpawnSyncReturns<string> {
    if (process.platform === 'win32') {
        const commandLine = ['npm.cmd', ...args].map(quoteWindowsArgument).join(' ');
        return childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
            cwd,
            encoding: 'utf8',
            timeout: NPM_COMMAND_TIMEOUT_MS,
            windowsHide: true
        });
    }
    return childProcess.spawnSync('npm', args, {
        cwd,
        encoding: 'utf8',
        timeout: NPM_COMMAND_TIMEOUT_MS,
        windowsHide: true
    });
}

function runNpm(args: string[], cwd: string): childProcess.SpawnSyncReturns<string> {
    const result = spawnNpm(args, cwd);
    assert.equal(
        result.status,
        0,
        [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n')
    );
    return result;
}

function parseNpmPackReport(stdout: string): NpmPackReport {
    const jsonStart = stdout.indexOf('[');
    assert.notEqual(jsonStart, -1, `npm pack JSON report missing:\n${stdout}`);
    const reports = JSON.parse(stdout.slice(jsonStart)) as NpmPackReport[];
    assert.equal(reports.length, 1);
    return reports[0];
}

function stagePackageFiles(repoRoot: string, packageRoot: string, report: NpmPackReport): void {
    for (const entry of report.files) {
        const relativePath = entry.path.replace(/\\/gu, '/');
        assert.equal(path.posix.normalize(relativePath), relativePath);
        assert.ok(!relativePath.startsWith('../') && !path.isAbsolute(relativePath));
        const sourcePath = path.join(repoRoot, relativePath);
        const targetPath = path.join(packageRoot, relativePath);
        assert.ok(fs.statSync(sourcePath).isFile(), `${relativePath} must be a packed file`);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
    }
}

function configurePackagedCustomCatalog(packageRoot: string): void {
    const configRoot = path.join(packageRoot, 'template', 'config');
    const catalogPath = path.join(configRoot, 'review-catalog.json');
    const capabilitiesPath = path.join(configRoot, 'review-capabilities.json');
    const profilesPath = path.join(configRoot, 'profiles.json');
    const catalog = readJson(catalogPath);
    catalog.custom_review_types = [{
        id: CUSTOM_REVIEW_ID,
        display_label: 'Library compatibility review',
        enabled_by_default: false,
        skill_id: 'dependency-review',
        trigger: { mode: 'signals', signal_ids: ['package:library'] },
        coverage_category_ids: ['dependencies'],
        reviewer_role: {
            role_id: 'library-reviewer',
            focus_tags: ['dependencies']
        }
    }];
    writeJson(catalogPath, catalog);

    const capabilities = readJson(capabilitiesPath);
    capabilities[CUSTOM_REVIEW_ID] = true;
    writeJson(capabilitiesPath, capabilities);

    const profiles = readJson(profilesPath);
    profiles.built_in_profiles.balanced.review_policy[CUSTOM_REVIEW_ID] = true;
    writeJson(profilesPath, profiles);
}

function installPackagedCustomCatalogFixture(
    repoRoot: string,
    tempRoot: string,
    requiredPackagePaths: string[]
): string {
    const dryRun = runNpm(['pack', '--dry-run', '--ignore-scripts', '--json'], repoRoot);
    const sourceReport = parseNpmPackReport(dryRun.stdout);
    const packedPaths = new Set(sourceReport.files.map((entry) => entry.path.replace(/\\/gu, '/')));
    for (const relativePath of requiredPackagePaths) {
        assert.ok(packedPaths.has(relativePath), `${relativePath} must be present in the npm package report`);
    }

    const stagingRoot = path.join(tempRoot, 'package-staging');
    stagePackageFiles(repoRoot, stagingRoot, sourceReport);
    configurePackagedCustomCatalog(stagingRoot);

    const packDestination = path.join(tempRoot, 'packed');
    fs.mkdirSync(packDestination, { recursive: true });
    const packed = runNpm([
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        packDestination
    ], stagingRoot);
    const packedReport = parseNpmPackReport(packed.stdout);
    const packedArchivePath = path.join(packDestination, packedReport.filename);
    assert.ok(fs.existsSync(packedArchivePath));

    const installRoot = path.join(tempRoot, 'install');
    fs.mkdirSync(installRoot, { recursive: true });
    writeJson(path.join(installRoot, 'package.json'), {
        name: 'review-catalog-release-smoke',
        version: '0.0.0',
        private: true
    });
    runNpm([
        'install',
        '--ignore-scripts',
        '--prefer-offline',
        '--no-audit',
        '--no-fund',
        '--no-progress',
        '--no-save',
        '--package-lock=false',
        packedArchivePath
    ], installRoot);
    return path.join(installRoot, 'node_modules', PACKAGE_JSON.name);
}

function runReviewCatalog(
    actionArgs: string[],
    targetRoot: string,
    bundleRoot: string
): CommandResult {
    const originalLog = console.log;
    console.log = () => undefined;
    try {
        const result = handleReviewCatalog([
            ...actionArgs,
            '--target-root', targetRoot,
            '--bundle-root', bundleRoot,
            '--json'
        ], PACKAGE_JSON);
        assert.ok(result);
        return result as CommandResult;
    } finally {
        console.log = originalLog;
    }
}

test('packed release fixture materializes a custom catalog across CLI, UI, and migration preview', () => {
    const repoRoot = process.cwd();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-catalog-release-'));
    const targetRoot = path.join(tempRoot, 'target');
    const liveConfigRoot = path.join(targetRoot, 'garda-agent-orchestrator', 'live', 'config');
    const packageVisiblePaths = [
        'template/config/review-catalog.json',
        'template/config/review-capabilities.json',
        'template/config/profiles.json',
        'docs/configuration.md',
        'docs/cli-reference.md'
    ];

    try {
        const installedPackageRoot = installPackagedCustomCatalogFixture(
            repoRoot,
            tempRoot,
            packageVisiblePaths
        );
        for (const relativePath of packageVisiblePaths) {
            assert.ok(
                fs.existsSync(path.join(installedPackageRoot, relativePath)),
                `${relativePath} must be installed`
            );
        }
        const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
        fs.cpSync(installedPackageRoot, bundleRoot, { recursive: true });
        runInit({
            targetRoot,
            bundleRoot,
            sourceOfTruth: 'Codex',
            assistantLanguage: 'English',
            assistantBrevity: 'concise'
        });

        const sourceCatalog = readJson(path.join(bundleRoot, 'template', 'config', 'review-catalog.json'));
        const materializedCatalogPath = path.join(liveConfigRoot, 'review-catalog.json');
        const materializedCapabilitiesPath = path.join(liveConfigRoot, 'review-capabilities.json');
        const materializedProfilesPath = path.join(liveConfigRoot, 'profiles.json');
        assert.deepEqual(readJson(materializedCatalogPath), sourceCatalog);
        assert.deepEqual(
            sourceCatalog.custom_review_types.map((definition: CommandResult) => definition.id),
            [CUSTOM_REVIEW_ID]
        );

        const validation = runReviewCatalog(['validate'], targetRoot, bundleRoot);
        assert.equal(validation.status, 'PASS');
        assert.deepEqual(validation.issues, []);

        const listed = runReviewCatalog(['list'], targetRoot, bundleRoot);
        assert.equal(listed.catalog_exists, true);
        assert.deepEqual(
            listed.lanes.map((lane: CommandResult) => lane.id),
            [...BUILT_IN_REVIEW_TYPE_IDS, CUSTOM_REVIEW_ID]
        );
        assert.equal(listed.lanes.find((lane: CommandResult) => lane.id === CUSTOM_REVIEW_ID)?.built_in, false);

        const shownCustom = runReviewCatalog(['show', CUSTOM_REVIEW_ID], targetRoot, bundleRoot);
        assert.equal(shownCustom.lane.profile_states.balanced, 'required');
        assert.equal(shownCustom.lane.verdict_tokens.pass, 'LIBRARY COMPATIBILITY REVIEW PASSED');
        assert.equal(shownCustom.lane.verdict_tokens.fail, 'LIBRARY COMPATIBILITY REVIEW FAILED');

        const uiCatalog = buildReviewCatalogTab(targetRoot, 'balanced');
        assert.equal(uiCatalog.status, 'present');
        assert.equal(uiCatalog.validation.status, 'PASS');
        assert.equal(uiCatalog.migration.status, 'current');
        assert.deepEqual(
            uiCatalog.lanes.map((lane) => lane.id),
            listed.lanes.map((lane: CommandResult) => lane.id)
        );
        const uiCustom = uiCatalog.lanes.find((lane) => lane.id === CUSTOM_REVIEW_ID);
        assert.equal(uiCustom?.profile.state, shownCustom.lane.profile_states.balanced);
        assert.deepEqual(uiCustom?.verdict_tokens, shownCustom.lane.verdict_tokens);

        const managedPaths = [
            materializedCatalogPath,
            materializedCapabilitiesPath,
            materializedProfilesPath,
            path.join(liveConfigRoot, 'workflow-config.json')
        ];
        const beforeMigration = new Map(
            managedPaths.map((filePath) => [filePath, fs.readFileSync(filePath, 'utf8')])
        );
        const migration = runReviewCatalog(['migrate'], targetRoot, bundleRoot);
        assert.equal(
            migration.changed,
            migration.before_state_sha256 !== migration.after_state_sha256
        );
        assert.equal(migration.migration_parity.status, 'PASS');
        assert.ok(Object.values(migration.migration_parity.contracts).every(
            (contract: any) => contract.equal === true
        ));
        const sourceCapabilities = readJson(materializedCapabilitiesPath) as ReviewCapabilitiesConfigMap;
        const sourceProfiles = readJson(materializedProfilesPath);
        assert.throws(
            () => analyzeReviewCatalogMigrationParity({
                catalogExists: true,
                sourceCatalogConfig: sourceCatalog,
                proposedCatalogConfig: sourceCatalog,
                sourceCapabilities,
                proposedCapabilities: {
                    ...sourceCapabilities,
                    code: !sourceCapabilities.code
                },
                sourceProfiles: sourceProfiles as any,
                proposedProfiles: sourceProfiles as any,
                knownSkillIds: ['dependency-review'],
                reviewExecutionPolicy: { mode: 'strict_sequential', configured: true }
            }),
            /retain the effective legacy review-capabilities contract|migration parity failed/iu
        );
        for (const [filePath, beforeText] of beforeMigration) {
            assert.equal(fs.readFileSync(filePath, 'utf8'), beforeText, `${filePath} changed during preview`);
        }
    } finally {
        fs.rmSync(tempRoot, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 100
        });
    }
});
