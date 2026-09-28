import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PackageJsonLike } from '../../../../src/cli/commands/cli-types';
import { PROJECT_MEMORY_INIT_REFRESH_PROMPT } from '../../../../src/core/project-memory-rollout';
import { OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE } from '../../../../src/core/workflow-config';
import { printUpdateAnnouncementSections } from '../../../../src/cli/commands/shared-command-utils';
import { withLifecycleOperationLock } from '../../../../src/lifecycle/lock/lifecycle-lock';

type UpdateCommandModule = typeof import('../../../../src/cli/commands/update-command');

function runUpdateWithLock(
    runner: (options: Record<string, unknown>) => void,
    options: { targetRoot: string } & Record<string, unknown>
): void {
    withLifecycleOperationLock(options.targetRoot, 'update', () => runner(options));
}

const WORKFLOW_CONFIG_MERGE_STATUS = 'live_config_missing_template_applied path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=false project_memory_maintenance.enabled=true project_memory_maintenance.mode=update review_cycle_guard.max_failed_non_test_reviews=10 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=template_default_applied';
const UPDATE_WARNING_TEXT = 'Review bundled announcement warnings before rollout.';
const QUALITY_GATE_ACTIONS_LINE = '    - After updating, run garda ui --actions and open the Quality Gate settings to review the default rules, adjust test-only exclusions, and add rules that match your project.';

function makeCacheModule(resolvedPath: string, exportsValue: Record<string, unknown>): NodeJS.Module {
    return {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        path: path.dirname(resolvedPath),
        exports: exportsValue,
        parent: null,
        children: [],
        paths: [],
        isPreloading: false
    } as unknown as NodeJS.Module;
}

function restoreCachedModule(resolvedPath: string, originalModule: NodeJS.Module | undefined): void {
    if (originalModule) {
        require.cache[resolvedPath] = originalModule;
        return;
    }
    delete require.cache[resolvedPath];
}

function loadFreshUpdateCommandWithStubs(stubs: Record<string, Record<string, unknown>>): {
    module: UpdateCommandModule;
    restore(): void;
} {
    const updateCommandPath = require.resolve('../../../../src/cli/commands/update-command');
    const moduleSnapshots = new Map<string, NodeJS.Module | undefined>();

    moduleSnapshots.set(updateCommandPath, require.cache[updateCommandPath]);
    for (const [resolvedPath, exportsValue] of Object.entries(stubs)) {
        moduleSnapshots.set(resolvedPath, require.cache[resolvedPath]);
        require.cache[resolvedPath] = makeCacheModule(resolvedPath, exportsValue);
    }
    delete require.cache[updateCommandPath];

    return {
        module: require(updateCommandPath) as UpdateCommandModule,
        restore() {
            for (const [resolvedPath, originalModule] of moduleSnapshots.entries()) {
                restoreCachedModule(resolvedPath, originalModule);
            }
        }
    };
}

function makeTempBundleFixture(): { workspaceRoot: string; bundleUpdateModulePath: string; cleanup(): void } {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-command-output-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const bundleUpdateModulePath = path.join(bundleRoot, 'dist', 'src', 'lifecycle', 'update.js');
    fs.mkdirSync(path.join(bundleRoot, 'dist', 'src', 'lifecycle'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    fs.writeFileSync(
        bundleUpdateModulePath,
        [
            'module.exports.runUpdate = function runUpdate() {',
            '    return {',
            "        previousVersion: '1.0.0',",
            "        updatedVersion: '1.1.0',",
            `        workflowConfigMergeStatus: ${JSON.stringify(WORKFLOW_CONFIG_MERGE_STATUS)},`,
            `        optionalQualityChecksNotice: ${JSON.stringify(OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE)},`,
            "        projectMemoryMaintenanceSummaryLine: 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true',",
            `        projectMemoryRefreshHandoffPrompt: ${JSON.stringify(PROJECT_MEMORY_INIT_REFRESH_PROMPT)},`,
            "        rollbackSnapshotPath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-1',",
            "        rollbackStatus: 'NOT_TRIGGERED',",
            "        updateReportPath: 'garda-agent-orchestrator/runtime/update-reports/update-1.md'",
            '    };',
            '};'
        ].join('\n'),
        'utf8'
    );
    const handoffPath = path.join(bundleRoot, 'dist', 'src', 'cli', 'commands', 'update-runtime-handoff.js');
    fs.mkdirSync(path.dirname(handoffPath), { recursive: true });
    fs.writeFileSync(handoffPath, [
        "const fs = require('node:fs');",
        "const update = require('../../lifecycle/update.js');",
        "fs.readFileSync(0, 'utf8');",
        'fs.writeSync(3, JSON.stringify({ result: update.runUpdate() }));'
    ].join('\n'));
    fs.writeFileSync(
        path.join(bundleRoot, 'live', 'config', 'update-messages.json'),
        JSON.stringify({
            messages: [
                {
                    version: '1.1.0',
                    title: 'Major registry note',
                    body: ['Re-check new workflow affordances.']
                }
            ]
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(bundleRoot, 'CHANGELOG.md'),
        [
            '# Changelog',
            '',
            '## Unreleased',
            '- pending',
            '',
            '## 1.1.0',
            '- added versioned notes',
            '',
            '## 1.0.0',
            '- initial release'
        ].join('\n'),
        'utf8'
    );
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.1.0\n', 'utf8');
    fs.writeFileSync(
        path.join(bundleRoot, 'live', 'version.json'),
        JSON.stringify({ Version: '1.1.0', UpdatedAt: '2026-05-18T00:00:00.000Z' }, null, 2),
        'utf8'
    );

    return {
        workspaceRoot,
        bundleUpdateModulePath,
        cleanup() {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    };
}

function captureConsoleLogs(callback: () => Promise<void>): Promise<string[]> {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
        lines.push(args.map((entry) => String(entry)).join(' '));
    };

    return callback()
        .then(() => lines)
        .finally(() => {
            console.log = originalLog;
        });
}

async function captureConsoleLogsWithForcedColor(callback: () => Promise<void>): Promise<string[]> {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    try {
        return await captureConsoleLogs(callback);
    } finally {
        if (previousForceColor === undefined) {
            delete process.env.FORCE_COLOR;
        } else {
            process.env.FORCE_COLOR = previousForceColor;
        }
        if (previousNoColor === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = previousNoColor;
        }
    }
}

async function captureConsoleLogsWithNoColor(callback: () => Promise<void>): Promise<string[]> {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
    try {
        return await captureConsoleLogs(callback);
    } finally {
        if (previousForceColor === undefined) {
            delete process.env.FORCE_COLOR;
        } else {
            process.env.FORCE_COLOR = previousForceColor;
        }
        if (previousNoColor === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = previousNoColor;
        }
    }
}

function assertHumanUpdateOutputOmitsInternalHandoffDetails(lines: string[]): void {
    assert.equal(lines.some((line) => line.includes('Workflow Config')), false);
    assert.equal(lines.some((line) => line.includes('MergeStatus:')), false);
    assert.equal(lines.some((line) => line.includes('Project Memory')), false);
    assert.equal(lines.some((line) => line.includes('Maintenance: Project memory maintenance:')), false);
    assert.equal(lines.some((line) => line.includes('RefreshHandoffPrompt:')), false);
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]+m/gu, '');
}

function plainLines(lines: string[]): string[] {
    return lines.map((line) => stripAnsi(line));
}

function assertPlainLine(lines: string[], expected: string): void {
    assert.equal(plainLines(lines).includes(expected), true, `missing line: ${expected}`);
}

function findRenderedLine(lines: string[], expected: string): string | undefined {
    return lines.find((line) => stripAnsi(line) === expected);
}

function assertColoredLine(lines: string[], expected: string, ansiPattern: RegExp): void {
    const line = findRenderedLine(lines, expected);
    assert.notEqual(line, undefined, `missing rendered line: ${expected}`);
    assert.match(line as string, ansiPattern);
}

function assertHumanUpdateOutputOmitsRawDiagnostics(lines: string[]): void {
    const text = plainLines(lines).join('\n');
    assert.equal(/\n(?:TargetRoot|RepoUrl|ReleaseProvenanceStatus|ReleaseProvenanceSummary|ReleaseProvenanceRecommendation|CurrentVersion|LatestVersion|UpdateApplied|CheckUpdateResult|PreviousVersion|UpdatedVersion|ResolvedPackageVersion|ResolvedPackageIntegrity):/u.test(`\n${text}`), false);
}

test('handleUpdate surfaces update messages and release notes in plain text and json output', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const originalBundleModule = require.cache[fixture.bundleUpdateModulePath];
        require.cache[fixture.bundleUpdateModulePath] = makeCacheModule(fixture.bundleUpdateModulePath, {
            runUpdate() {
                return {
                    previousVersion: 'stale-version',
                    updatedVersion: '0.0.1',
                    workflowConfigMergeStatus: WORKFLOW_CONFIG_MERGE_STATUS,
                    optionalQualityChecksNotice: OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE,
                    projectMemoryMaintenanceSummaryLine: 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true',
                    projectMemoryRefreshHandoffPrompt: PROJECT_MEMORY_INIT_REFRESH_PROMPT,
                    rollbackSnapshotPath: 'stale-snapshot',
                    rollbackStatus: 'STALE',
                    updateReportPath: 'stale-report',
                    updateAnnouncementWarnings: [UPDATE_WARNING_TEXT]
                };
            }
        });
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        runUpdateWithLock(options.updateRunner, {
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'overridden',
                            trustOverrideUsed: true,
                            trustOverrideSource: 'cli',
                            sourceType: 'path',
                            sourceReference: 'fixture',
                            requestedPackageSpec: 'garda-agent-orchestrator@latest',
                            exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                            resolvedPackageVersion: '1.1.0',
                            resolvedPackageIntegrity: 'sha512-output'
                        });
                    }
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        requestedPackageSpec: 'garda-agent-orchestrator@latest',
                        exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                        resolvedPackageVersion: '1.1.0',
                        resolvedPackageIntegrity: 'sha512-output',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'overridden',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.match(plainTextLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(plainTextLines[1], /\u001b\[32mUpdated successfully\u001b\[0m/);
            assert.match(plainTextLines[2], /\u001b\[2mThe available update was applied to this workspace\.\u001b\[0m/);
            assert.match(plainTextLines[4], /\u001b\[1mVersion applied\u001b\[0m \u001b\[33m1\.0\.0\u001b\[0m \u001b\[2m->\u001b\[0m \u001b\[32m1\.1\.0\u001b\[0m/);
            assertPlainLine(plainTextLines, 'Result');
            assertPlainLine(plainTextLines, '  Status: UPDATED');
            assertPlainLine(plainTextLines, '  Applied: yes');
            assertPlainLine(plainTextLines, '  Version: 1.0.0 -> 1.1.0');
            assertPlainLine(plainTextLines, `  Optional checks notice: ${OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE}`);
            assertPlainLine(plainTextLines, 'Source');
            assertPlainLine(plainTextLines, '  Package: garda-agent-orchestrator@1.1.0');
            assertPlainLine(plainTextLines, '  Integrity: sha512-output');
            assertPlainLine(plainTextLines, 'Safety');
            assertPlainLine(plainTextLines, '  Trust override: yes');
            assertPlainLine(plainTextLines, 'Recovery');
            assertPlainLine(plainTextLines, '  Report: garda-agent-orchestrator/runtime/update-reports/update-1.md');
            assertPlainLine(plainTextLines, 'Detailed diagnostics are available in the update report and with --json.');
            assertHumanUpdateOutputOmitsRawDiagnostics(plainTextLines);
            assertHumanUpdateOutputOmitsInternalHandoffDetails(plainTextLines);
            assertPlainLine(plainTextLines, 'UpdateMessages:');
            assertPlainLine(plainTextLines, '  1.1.0 - Major registry note');
            assertPlainLine(plainTextLines, 'ReleaseNotes:');
            assertPlainLine(plainTextLines, '    - added versioned notes');
            assertColoredLine(plainTextLines, 'UpdateMessages:', /^\u001b\[36mUpdateMessages:\u001b\[0m$/);
            assertColoredLine(plainTextLines, '  1.1.0 - Major registry note', /^\u001b\[32m  1\.1\.0 - Major registry note\u001b\[0m$/);
            assertColoredLine(plainTextLines, '    - Re-check new workflow affordances.', /^\u001b\[32m    - Re-check new workflow affordances\.\u001b\[0m$/);
            assertColoredLine(plainTextLines, 'ReleaseNotes:', /^\u001b\[36mReleaseNotes:\u001b\[0m$/);
            assertColoredLine(plainTextLines, '    - added versioned notes', /^\u001b\[32m    - added versioned notes\u001b\[0m$/);
            assert.notEqual(require.cache[fixture.bundleUpdateModulePath], undefined);

            const noColorLines = await captureConsoleLogsWithNoColor(async () => {
                await reloaded.module.handleUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });
            assert.equal(/\u001b\[/.test(noColorLines.join('\n')), false);
            assert.equal(noColorLines[0], 'UPDATE STATUS');
            assert.equal(noColorLines[1], 'Updated successfully');
            assert.equal(noColorLines[2], 'The available update was applied to this workspace.');
            assertPlainLine(noColorLines, '  Status: UPDATED');
            assertPlainLine(noColorLines, '  Version: 1.0.0 -> 1.1.0');
            assertHumanUpdateOutputOmitsRawDiagnostics(noColorLines);
            assertHumanUpdateOutputOmitsInternalHandoffDetails(noColorLines);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.previousVersion, '1.0.0');
            assert.equal(parsed.updatedVersion, '1.1.0');
            assert.equal(parsed.requestedPackageSpec, 'garda-agent-orchestrator@latest');
            assert.equal(parsed.exactPackageSpec, 'garda-agent-orchestrator@1.1.0');
            assert.equal(parsed.resolvedPackageVersion, '1.1.0');
            assert.equal(parsed.resolvedPackageIntegrity, 'sha512-output');
            assert.equal(
                parsed.workflowConfigMergeStatus,
                WORKFLOW_CONFIG_MERGE_STATUS
            );
            assert.equal(parsed.optionalQualityChecksNotice, OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE);
            assert.equal(parsed.projectMemoryMaintenanceSummaryLine, 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true');
            assert.equal(parsed.projectMemoryRefreshHandoffPrompt, PROJECT_MEMORY_INIT_REFRESH_PROMPT);
            assert.equal(parsed.updateMessages[0].title, 'Major registry note');
            assert.equal(parsed.releaseNotes[0].version, '1.1.0');
        } finally {
            reloaded.restore();
            restoreCachedModule(fixture.bundleUpdateModulePath, originalBundleModule);
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleCheckUpdate --apply includes UpdateApplied in plain text and enriches announcements after apply', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const originalBundleModule = require.cache[fixture.bundleUpdateModulePath];
        require.cache[fixture.bundleUpdateModulePath] = makeCacheModule(fixture.bundleUpdateModulePath, {
            runUpdate() {
                return {
                    previousVersion: 'stale-version',
                    updatedVersion: '0.0.1',
                    projectMemoryMaintenanceSummaryLine: 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true',
                    projectMemoryRefreshHandoffPrompt: PROJECT_MEMORY_INIT_REFRESH_PROMPT,
                    rollbackSnapshotPath: 'stale-snapshot',
                    rollbackStatus: 'STALE',
                    updateReportPath: 'stale-report',
                    updateAnnouncementWarnings: [UPDATE_WARNING_TEXT]
                };
            }
        });
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        runUpdateWithLock(options.updateRunner, {
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'overridden',
                            trustOverrideUsed: true,
                            trustOverrideSource: 'cli',
                            sourceType: 'path',
                            sourceReference: 'fixture',
                            requestedPackageSpec: 'garda-agent-orchestrator@latest',
                            exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                            resolvedPackageVersion: '1.1.0',
                            resolvedPackageIntegrity: 'sha512-check'
                        });
                    }
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        requestedPackageSpec: 'garda-agent-orchestrator@latest',
                        exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                        resolvedPackageVersion: '1.1.0',
                        resolvedPackageIntegrity: 'sha512-check',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'overridden',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--apply',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.match(plainTextLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(plainTextLines[1], /\u001b\[32mUpdated successfully\u001b\[0m/);
            assert.match(plainTextLines[4], /\u001b\[1mVersion applied\u001b\[0m \u001b\[33m1\.0\.0\u001b\[0m \u001b\[2m->\u001b\[0m \u001b\[32m1\.1\.0\u001b\[0m/);
            assertPlainLine(plainTextLines, 'Result');
            assertPlainLine(plainTextLines, '  Status: UPDATED');
            assertPlainLine(plainTextLines, '  Applied: yes');
            assertPlainLine(plainTextLines, '  Version: 1.0.0 -> 1.1.0');
            assertPlainLine(plainTextLines, '  Package: garda-agent-orchestrator@1.1.0');
            assertPlainLine(plainTextLines, '  Integrity: sha512-check');
            assertPlainLine(plainTextLines, '  Report: garda-agent-orchestrator/runtime/update-reports/update-1.md');
            assertPlainLine(plainTextLines, 'Detailed diagnostics are available in the update report and with --json.');
            assertHumanUpdateOutputOmitsRawDiagnostics(plainTextLines);
            assertHumanUpdateOutputOmitsInternalHandoffDetails(plainTextLines);
            assertPlainLine(plainTextLines, 'UpdateMessages:');
            assertPlainLine(plainTextLines, 'ReleaseNotes:');
            assertColoredLine(plainTextLines, 'UpdateMessages:', /^\u001b\[36mUpdateMessages:\u001b\[0m$/);
            assertColoredLine(plainTextLines, '  1.1.0 - Major registry note', /^\u001b\[32m  1\.1\.0 - Major registry note\u001b\[0m$/);
            assertColoredLine(plainTextLines, 'ReleaseNotes:', /^\u001b\[36mReleaseNotes:\u001b\[0m$/);
            assert.notEqual(require.cache[fixture.bundleUpdateModulePath], undefined);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--apply',
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(
                parsed.workflowConfigMergeStatus,
                WORKFLOW_CONFIG_MERGE_STATUS
            );
            assert.equal(parsed.projectMemoryMaintenanceSummaryLine, 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true');
            assert.equal(parsed.projectMemoryRefreshHandoffPrompt, PROJECT_MEMORY_INIT_REFRESH_PROMPT);
            assert.equal(parsed.requestedPackageSpec, 'garda-agent-orchestrator@latest');
            assert.equal(parsed.exactPackageSpec, 'garda-agent-orchestrator@1.1.0');
            assert.equal(parsed.resolvedPackageVersion, '1.1.0');
            assert.equal(parsed.resolvedPackageIntegrity, 'sha512-check');
        } finally {
            reloaded.restore();
            restoreCachedModule(fixture.bundleUpdateModulePath, originalBundleModule);
        }
    } finally {
        fixture.cleanup();
    }
});

test('printUpdateAnnouncementSections highlights garda ui actions in yellow within update messages', async () => {
    const messageResult = {
        updateMessages: [
            {
                version: '1.2.0',
                title: 'Optional quality gate controls',
                body: [
                    'After updating, run garda ui --actions and open the Quality Gate settings to review the default rules, adjust test-only exclusions, and add rules that match your project.'
                ]
            }
        ]
    };

    const coloredLines = await captureConsoleLogsWithForcedColor(async () => {
        printUpdateAnnouncementSections(messageResult);
    });
    assertPlainLine(coloredLines, 'UpdateMessages:');
    assertPlainLine(coloredLines, QUALITY_GATE_ACTIONS_LINE);
    assertColoredLine(
        coloredLines,
        QUALITY_GATE_ACTIONS_LINE,
        /^\u001b\[32m    - After updating, run \u001b\[0m\u001b\[33mgarda ui --actions\u001b\[0m\u001b\[32m and open the Quality Gate settings to review the default rules, adjust test-only exclusions, and add rules that match your project\.\u001b\[0m$/
    );

    const noColorLines = await captureConsoleLogsWithNoColor(async () => {
        printUpdateAnnouncementSections(messageResult);
    });
    assert.equal(/\u001b\[/.test(noColorLines.join('\n')), false);
    assertPlainLine(noColorLines, QUALITY_GATE_ACTIONS_LINE);
});

test('printUpdateAnnouncementSections renders warnings in yellow and keeps no-color plain text', async () => {
    const warningResult = {
        updateAnnouncementWarnings: [UPDATE_WARNING_TEXT]
    };

    const coloredLines = await captureConsoleLogsWithForcedColor(async () => {
        printUpdateAnnouncementSections(warningResult);
    });
    assertPlainLine(coloredLines, 'UpdateAnnouncementWarnings:');
    assertPlainLine(coloredLines, `- ${UPDATE_WARNING_TEXT}`);
    assertColoredLine(coloredLines, 'UpdateAnnouncementWarnings:', /^\u001b\[33mUpdateAnnouncementWarnings:\u001b\[0m$/);
    assertColoredLine(coloredLines, `- ${UPDATE_WARNING_TEXT}`, /^\u001b\[33m- Review bundled announcement warnings before rollout\.\u001b\[0m$/);

    const noColorLines = await captureConsoleLogsWithNoColor(async () => {
        printUpdateAnnouncementSections(warningResult);
    });
    assert.equal(/\u001b\[/.test(noColorLines.join('\n')), false);
    assertPlainLine(noColorLines, 'UpdateAnnouncementWarnings:');
    assertPlainLine(noColorLines, `- ${UPDATE_WARNING_TEXT}`);
});

test('handleCheckUpdate --apply corrects stale lifecycle UpdatedVersion after deferred version sync', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();
    const bundleRoot = path.join(fixture.workspaceRoot, 'garda-agent-orchestrator');
    const updateReportRelativePath = 'garda-agent-orchestrator/runtime/update-reports/update-stale.md';
    const updateReportPath = path.join(fixture.workspaceRoot, updateReportRelativePath);

    try {
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'version.json'),
            JSON.stringify({ Version: '1.0.0', UpdatedAt: '2026-05-18T00:00:00.000Z' }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            fixture.bundleUpdateModulePath,
            [
                'module.exports.runUpdate = function runUpdate() {',
                '    return {',
                "        previousVersion: '1.0.0',",
                "        updatedVersion: '1.0.0',",
                "        rollbackSnapshotPath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-stale',",
                "        rollbackStatus: 'NOT_TRIGGERED',",
                `        updateReportPath: ${JSON.stringify(updateReportRelativePath)}`,
                '    };',
                '};'
            ].join('\n'),
            'utf8'
        );
        fs.mkdirSync(path.dirname(updateReportPath), { recursive: true });
        fs.writeFileSync(
            updateReportPath,
            [
                '# Update Report',
                '',
                'PreviousVersion: 1.0.0',
                'BundleVersion: 1.0.0',
                'UpdatedVersion: 1.0.0'
            ].join('\n'),
            'utf8'
        );

        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        runUpdateWithLock(options.updateRunner, {
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'overridden',
                            trustOverrideUsed: true,
                            trustOverrideSource: 'cli',
                            sourceType: 'path',
                            sourceReference: 'fixture',
                            requestedPackageSpec: 'garda-agent-orchestrator@latest',
                            exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                            resolvedPackageVersion: '1.1.0',
                            resolvedPackageIntegrity: 'sha512-check'
                        });
                    }
                    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.1.0\n', 'utf8');
                    fs.writeFileSync(
                        path.join(bundleRoot, 'live', 'version.json'),
                        JSON.stringify({ Version: '1.1.0', UpdatedAt: '2026-05-18T01:00:00.000Z' }, null, 2),
                        'utf8'
                    );
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        requestedPackageSpec: 'garda-agent-orchestrator@latest',
                        exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                        resolvedPackageVersion: '1.1.0',
                        resolvedPackageIntegrity: 'sha512-check',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'overridden',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithNoColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--apply',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });
            assertPlainLine(plainTextLines, '  Version: 1.0.0 -> 1.1.0');
            assertHumanUpdateOutputOmitsRawDiagnostics(plainTextLines);
            assert.match(fs.readFileSync(updateReportPath, 'utf8'), /^UpdatedVersion: 1\.1\.0$/m);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--apply',
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.updatedVersion, '1.1.0');
        } finally {
            reloaded.restore();
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleCheckUpdate surfaces a green up-to-date banner in plain text without changing json output', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate() {
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        currentVersion: '1.1.0',
                        latestVersion: '1.1.0',
                        updateAvailable: false,
                        updateApplied: false,
                        checkUpdateResult: 'UP_TO_DATE',
                        trustPolicy: 'overridden',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.match(plainTextLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(plainTextLines[1], /\u001b\[32mAlready up to date\u001b\[0m/);
            assert.match(plainTextLines[2], /\u001b\[2mNo update was needed for this workspace\.\u001b\[0m/);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.checkUpdateResult, 'UP_TO_DATE');
            assert.equal(parsed.updateAvailable, false);
            assert.equal(parsed.updateApplied, false);
        } finally {
            reloaded.restore();
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleCheckUpdate surfaces a yellow update-available banner in color mode and plain text in NO_COLOR mode', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate() {
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: false,
                        checkUpdateResult: 'UPDATE_AVAILABLE',
                        trustPolicy: 'overridden',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const colorLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });
            assert.match(colorLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(colorLines[1], /\u001b\[33mUpdate available\u001b\[0m/);
            assert.match(colorLines[2], /\u001b\[2mA newer version is available for this workspace\.\u001b\[0m/);
            assert.match(colorLines[4], /\u001b\[1mVersion available\u001b\[0m \u001b\[33m1\.0\.0\u001b\[0m \u001b\[2m->\u001b\[0m \u001b\[36m1\.1\.0\u001b\[0m/);

            const noColorLines = await captureConsoleLogsWithNoColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });
            assert.equal(/\u001b\[/.test(noColorLines.slice(0, 3).join('\n')), false);
            assert.equal(noColorLines[0], 'UPDATE STATUS');
            assert.equal(noColorLines[1], 'Update available');
            assert.equal(noColorLines[2], 'A newer version is available for this workspace.');

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.checkUpdateResult, 'UPDATE_AVAILABLE');
            assert.equal(parsed.updateAvailable, true);
            assert.equal(parsed.updateApplied, false);
        } finally {
            reloaded.restore();
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleCheckUpdate surfaces a yellow dry-run banner without changing json output', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate() {
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: false,
                        checkUpdateResult: 'DRY_RUN_UPDATE_AVAILABLE',
                        trustPolicy: 'overridden',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--dry-run',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.match(plainTextLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(plainTextLines[1], /\u001b\[33mDry run: update available\u001b\[0m/);
            assert.match(plainTextLines[2], /\u001b\[2mA newer version is available, but dry-run did not apply it\.\u001b\[0m/);
            assert.match(plainTextLines[4], /\u001b\[1mVersion available\u001b\[0m \u001b\[33m1\.0\.0\u001b\[0m \u001b\[2m->\u001b\[0m \u001b\[36m1\.1\.0\u001b\[0m/);

            const noColorLines = await captureConsoleLogsWithNoColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--dry-run',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });
            assert.equal(/\u001b\[/.test(noColorLines.slice(0, 3).join('\n')), false);
            assert.equal(noColorLines[0], 'UPDATE STATUS');
            assert.equal(noColorLines[1], 'Dry run: update available');
            assert.equal(noColorLines[2], 'A newer version is available, but dry-run did not apply it.');

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--dry-run',
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.checkUpdateResult, 'DRY_RUN_UPDATE_AVAILABLE');
            assert.equal(parsed.updateAvailable, true);
            assert.equal(parsed.updateApplied, false);
        } finally {
            reloaded.restore();
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleUpdateGit surfaces the shared status banner in plain text without changing json output', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const updateGitModulePath = require.resolve('../../../../src/lifecycle/update-git');
    const fixture = makeTempBundleFixture();

    try {
        const originalBundleModule = require.cache[fixture.bundleUpdateModulePath];
        require.cache[fixture.bundleUpdateModulePath] = makeCacheModule(fixture.bundleUpdateModulePath, {
            runUpdate() {
                return {
                    previousVersion: 'stale-version',
                    updatedVersion: '0.0.1',
                    rollbackSnapshotPath: 'stale-snapshot',
                    rollbackStatus: 'STALE',
                    updateReportPath: 'stale-report'
                };
            }
        });
        const reloaded = loadFreshUpdateCommandWithStubs({
            [updateGitModulePath]: {
                async runUpdateFromGit(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        runUpdateWithLock(options.updateRunner, {
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'overridden',
                            trustOverrideUsed: true,
                            trustOverrideSource: 'cli',
                            sourceType: 'git',
                            sourceReference: 'fixture',
                            gitCommitSha: '0123456789abcdef0123456789abcdef01234567'
                        });
                    }
                    return {
                        targetRoot: fixture.workspaceRoot,
                        repoUrl: 'https://example.test/repo.git',
                        branch: 'main',
                        gitCommitSha: '0123456789abcdef0123456789abcdef01234567',
                        sourceType: 'git',
                        sourceReference: 'fixture',
                        releaseProvenanceStatus: 'TRUSTED_GIT_NO_RELEASE_SIGNATURE',
                        releaseProvenanceSummary: 'Trusted git source details should stay out of default stdout.',
                        releaseProvenanceRecommendation: 'Prefer check-only first.',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'overridden',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleUpdateGit([
                    '--target-root', fixture.workspaceRoot,
                    '--repo-url', 'https://example.test/repo.git',
                    '--branch', 'main',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.match(plainTextLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(plainTextLines[1], /\u001b\[32mUpdated successfully\u001b\[0m/);
            assert.match(plainTextLines[2], /\u001b\[2mThe available update was applied to this workspace\.\u001b\[0m/);
            assert.match(plainTextLines[4], /\u001b\[1mVersion applied\u001b\[0m \u001b\[33m1\.0\.0\u001b\[0m \u001b\[2m->\u001b\[0m \u001b\[32m1\.1\.0\u001b\[0m/);
            assertPlainLine(plainTextLines, '  Repo: https://example.test/repo.git');
            assertPlainLine(plainTextLines, '  Branch: main');
            assertPlainLine(plainTextLines, '  Git commit: 0123456789abcdef0123456789abcdef01234567');
            assertPlainLine(plainTextLines, '  Version: 1.0.0 -> 1.1.0');
            assertPlainLine(plainTextLines, '  Provenance: trusted git source; no release signature for git sources (details in update report)');
            assertPlainLine(plainTextLines, '  Report: garda-agent-orchestrator/runtime/update-reports/update-1.md');
            assertPlainLine(plainTextLines, 'Detailed diagnostics are available in the update report and with --json.');
            assert.equal(plainLines(plainTextLines).some((line) => line.includes('Trusted git source details should stay out')), false);
            assert.equal(plainLines(plainTextLines).some((line) => line.includes('Prefer check-only first')), false);
            assertHumanUpdateOutputOmitsRawDiagnostics(plainTextLines);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleUpdateGit([
                    '--target-root', fixture.workspaceRoot,
                    '--repo-url', 'https://example.test/repo.git',
                    '--branch', 'main',
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.checkUpdateResult, 'UPDATED');
            assert.equal(parsed.sourceType, 'git');
            assert.equal(parsed.repoUrl, 'https://example.test/repo.git');
            assert.equal(parsed.gitCommitSha, '0123456789abcdef0123456789abcdef01234567');
            assert.equal(parsed.updatedVersion, '1.1.0');
            assert.equal(parsed.releaseProvenanceSummary, 'Trusted git source details should stay out of default stdout.');
        } finally {
            reloaded.restore();
            restoreCachedModule(fixture.bundleUpdateModulePath, originalBundleModule);
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleUpdateGit keeps same-version content drift sync output operator-focused', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const updateGitModulePath = require.resolve('../../../../src/lifecycle/update-git');
    const fixture = makeTempBundleFixture();

    try {
        const originalBundleModule = require.cache[fixture.bundleUpdateModulePath];
        require.cache[fixture.bundleUpdateModulePath] = makeCacheModule(fixture.bundleUpdateModulePath, {
            runUpdate() {
                return {
                    previousVersion: '1.1.0',
                    updatedVersion: '1.1.0',
                    workflowConfigMergeStatus: WORKFLOW_CONFIG_MERGE_STATUS,
                    projectMemoryMaintenanceSummaryLine: 'Project memory maintenance: update read_strategy=index_first',
                    projectMemoryRefreshHandoffPrompt: PROJECT_MEMORY_INIT_REFRESH_PROMPT,
                    rollbackSnapshotPath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-drift',
                    rollbackStatus: 'NOT_TRIGGERED',
                    updateReportPath: 'garda-agent-orchestrator/runtime/update-reports/update-drift.md'
                };
            }
        });
        const reloaded = loadFreshUpdateCommandWithStubs({
            [updateGitModulePath]: {
                async runUpdateFromGit(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        runUpdateWithLock(options.updateRunner, {
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'overridden',
                            trustOverrideUsed: true,
                            trustOverrideSource: 'cli',
                            sourceType: 'git',
                            sourceReference: 'https://example.test/repo.git'
                        });
                    }
                    return {
                        targetRoot: fixture.workspaceRoot,
                        repoUrl: 'https://example.test/repo.git',
                        branch: 'dev',
                        sourceType: 'git',
                        sourceReference: 'https://example.test/repo.git',
                        currentVersion: '1.1.0',
                        latestVersion: '1.1.0',
                        updateAvailable: false,
                        versionDiffDetected: false,
                        contentDriftDetected: true,
                        driftedSyncItems: ['dist', 'live'],
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'overridden',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithNoColor(async () => {
                await reloaded.module.handleUpdateGit([
                    '--target-root', fixture.workspaceRoot,
                    '--repo-url', 'https://example.test/repo.git',
                    '--branch', 'dev',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.equal(plainTextLines[0], 'UPDATE STATUS');
            assert.equal(plainTextLines[1], 'Updated successfully');
            assert.equal(plainTextLines.some((line) => line.includes('Version applied')), false);
            assertPlainLine(plainTextLines, '  Status: UPDATED');
            assertPlainLine(plainTextLines, '  Applied: yes');
            assert.equal(plainLines(plainTextLines).some((line) => line.startsWith('  Version: ') && line.includes('1.1.0')), true);
            assertPlainLine(plainTextLines, '  Content drift: yes');
            assertPlainLine(plainTextLines, '  Drifted items: dist, live');
            assertHumanUpdateOutputOmitsRawDiagnostics(plainTextLines);
            assertHumanUpdateOutputOmitsInternalHandoffDetails(plainTextLines);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleUpdateGit([
                    '--target-root', fixture.workspaceRoot,
                    '--repo-url', 'https://example.test/repo.git',
                    '--branch', 'dev',
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.contentDriftDetected, true);
            assert.equal(parsed.workflowConfigMergeStatus, WORKFLOW_CONFIG_MERGE_STATUS);
            assert.equal(parsed.projectMemoryMaintenanceSummaryLine, 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true');
            assert.equal(parsed.projectMemoryRefreshHandoffPrompt, PROJECT_MEMORY_INIT_REFRESH_PROMPT);
        } finally {
            reloaded.restore();
            restoreCachedModule(fixture.bundleUpdateModulePath, originalBundleModule);
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleUpdateGit uses latest applied version for announcements when lifecycle output is stale', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const updateGitModulePath = require.resolve('../../../../src/lifecycle/update-git');
    const fixture = makeTempBundleFixture();
    const bundleRoot = path.join(fixture.workspaceRoot, 'garda-agent-orchestrator');

    try {
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'version.json'),
            JSON.stringify({ Version: '1.0.0', UpdatedAt: '2026-05-18T00:00:00.000Z' }, null, 2),
            'utf8'
        );
        const originalBundleModule = require.cache[fixture.bundleUpdateModulePath];
        require.cache[fixture.bundleUpdateModulePath] = makeCacheModule(fixture.bundleUpdateModulePath, {
            runUpdate() {
                return {
                    previousVersion: '1.0.0',
                    updatedVersion: '1.0.0',
                    projectMemoryMaintenanceSummaryLine: 'Project memory maintenance: update read_strategy=index_first',
                    projectMemoryRefreshHandoffPrompt: PROJECT_MEMORY_INIT_REFRESH_PROMPT,
                    rollbackSnapshotPath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-stale',
                    rollbackStatus: 'NOT_TRIGGERED',
                    updateReportPath: 'garda-agent-orchestrator/runtime/update-reports/update-stale.md'
                };
            }
        });

        const reloaded = loadFreshUpdateCommandWithStubs({
            [updateGitModulePath]: {
                async runUpdateFromGit(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        runUpdateWithLock(options.updateRunner, {
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'enforced',
                            trustOverrideUsed: false,
                            trustOverrideSource: 'none',
                            sourceType: 'git',
                            sourceReference: 'https://example.test/repo.git'
                        });
                    }
                    return {
                        targetRoot: fixture.workspaceRoot,
                        repoUrl: 'https://example.test/repo.git',
                        branch: 'dev',
                        sourceType: 'git',
                        sourceReference: 'https://example.test/repo.git',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'enforced',
                        trustOverrideUsed: false,
                        trustOverrideSource: 'none'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithNoColor(async () => {
                await reloaded.module.handleUpdateGit([
                    '--target-root', fixture.workspaceRoot,
                    '--repo-url', 'https://example.test/repo.git',
                    '--branch', 'dev',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.equal(/\u001b\[/.test(plainTextLines.join('\n')), false);
            assertPlainLine(plainTextLines, '  Version: 1.0.0 -> 1.1.0');
            assertHumanUpdateOutputOmitsRawDiagnostics(plainTextLines);
            assert.equal(plainTextLines.includes('UpdateMessages:'), true);
            assert.equal(plainTextLines.includes('  1.1.0 - Major registry note'), true);
            assertHumanUpdateOutputOmitsInternalHandoffDetails(plainTextLines);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleUpdateGit([
                    '--target-root', fixture.workspaceRoot,
                    '--repo-url', 'https://example.test/repo.git',
                    '--branch', 'dev',
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.updatedVersion, '1.1.0');
            assert.equal(parsed.latestVersion, '1.1.0');
        } finally {
            reloaded.restore();
            restoreCachedModule(fixture.bundleUpdateModulePath, originalBundleModule);
        }
    } finally {
        fixture.cleanup();
    }
});
