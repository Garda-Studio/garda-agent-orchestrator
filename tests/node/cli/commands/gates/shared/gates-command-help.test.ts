import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    buildGateCommandOverviewText,
    buildGateHelpText,
    buildTaskIdSyntaxRemediationMessage
} from '../../../../../../src/cli/commands/gate-command-help';
import { getAllShimmedGateNames } from '../../../../../../src/compat/shim-registry';
import { splitCommandLine } from '../../../../../../src/cli/commands/gates';

import {
    runCliWithCapturedOutput
} from '../../gate-test-helpers';

const TASK_ID_REMEDIATION_GATE_NAMES = Object.freeze([
    'enter-task-mode',
    'load-rule-pack',
    'bind-rule-pack-to-preflight',
    'record-no-op',
    'record-strict-decomposition-decision',
    'handshake-diagnostics',
    'shell-smoke-preflight',
    'command-timeout-diagnostics',
    'quality-checklist',
    'run-intermediate-command',
    'classify-change',
    'restart-coherent-cycle',
    'restart-review-cycle',
    'compile-gate',
    'activate-optional-skill',
    'required-reviews-check',
    'doc-impact-gate',
    'full-suite-validation',
    'record-review-result',
    'record-review-routing',
    'prepare-reviewer-launch',
    'record-review-invocation',
    'record-review-receipt',
    'completion-gate',
    'log-task-event',
    'task-events-summary',
    'task-audit-summary',
    'next-step'
]);

function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function getSourceCheckoutNestedCwd(): string {
    return path.join(path.resolve('.'), 'src', 'cli');
}

const FORBIDDEN_DEFAULT_REVIEWER_RESERVATION_GUIDANCE = [
    'STANDBY',
    'standby',
    'idle wait',
    'idle reviewer',
    'resumable session',
    'resumable reviewer',
    'reviewer reservation',
    'pre-launch reviewer reservation',
    'reserve a reviewer',
    'keep the reviewer alive',
    'wait for further instructions'
];

function assertNoDefaultReviewerReservationGuidance(text: string): void {
    for (const forbiddenText of FORBIDDEN_DEFAULT_REVIEWER_RESERVATION_GUIDANCE) {
        assert.equal(
            text.includes(forbiddenText),
            false,
            `default reviewer launch guidance must not include ${forbiddenText}`
        );
    }
}

describe('cli/commands/gates command help and syntax remediation', () => {
    it('splits quoted command lines', () => {
        assert.deepEqual(
            splitCommandLine('node -e "console.log(\'ok\')"'),
            ['node', '-e', "console.log('ok')"]
        );
    });

    it('preserves backslashes in quoted Windows executable paths', () => {
        assert.deepEqual(
            splitCommandLine('"C:\\Program Files\\nodejs\\npm.cmd" --version'),
            ['C:\\Program Files\\nodejs\\npm.cmd', '--version']
        );
    });

    it('prints gate subcommand help without triggering required-argument validation', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        const helpCases: Array<{ argv: string[]; expectedSnippets: string[] }> = [
            {
                argv: ['gate', 'enter-task-mode', '--help'],
                expectedSnippets: ['gate enter-task-mode', '--task-id "<task-id>"', '--routed-to "<provider-bridge-or-entrypoint>"']
            },
            {
                argv: ['gate', 'build-review-context', '--help'],
                expectedSnippets: ['gate build-review-context', '--review-type "<code|db|security|refactor|api|test|performance|infra|dependency>"', '--preflight-path']
            },
            {
                argv: ['gate', 'activate-optional-skill', '--help'],
                expectedSnippets: ['gate activate-optional-skill', '--task-id "<task-id>"', '--skill-id "<selected-skill-id>"']
            },
            {
                argv: ['gate', 'completion-gate', '--help'],
                expectedSnippets: ['gate completion-gate', '--task-id "<task-id>"', '--preflight-path']
            },
            {
                argv: ['gate', 'full-suite-validation', '--help'],
                expectedSnippets: ['gate full-suite-validation', '--task-id "<task-id>"', '--preflight-path']
            },
            {
                argv: ['gate', 'restart-coherent-cycle', '--help'],
                expectedSnippets: [
                    'gate restart-coherent-cycle',
                    'reruns the configured compile gate and can take the full project compile duration'
                ]
            },
            {
                argv: ['gate', 'record-review-result', '--help'],
                expectedSnippets: [
                    'gate record-review-result',
                    'close or release the delegated reviewer after the receipt persists',
                    '--reviewer-execution-mode "delegated_subagent"'
                ]
            },
            {
                argv: ['gate', 'record-review-receipt', '--help'],
                expectedSnippets: [
                    'gate record-review-receipt',
                    'close or release the delegated reviewer after the receipt persists',
                    '--reviewer-execution-mode "delegated_subagent"'
                ]
            }
        ];

        for (const helpCase of helpCases) {
            const result = await runCliWithCapturedOutput(helpCase.argv, { cwd: sourceCheckoutNestedCwd });
            assert.equal(result.exitCode, 0, helpCase.argv.join(' '));
            assert.equal(result.errors.length, 0, helpCase.argv.join(' '));
            const combinedOutput = result.logs.join('\n');
            for (const snippet of helpCase.expectedSnippets) {
                assert.ok(combinedOutput.includes(snippet), `${helpCase.argv.join(' ')} must include '${snippet}'`);
            }
        }
    });

    it('prints help successfully for every public gate subcommand', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        for (const gateName of getAllShimmedGateNames()) {
            const result = await runCliWithCapturedOutput(['gate', gateName, '--help'], { cwd: sourceCheckoutNestedCwd });
            assert.equal(result.exitCode, 0, gateName);
            assert.equal(result.errors.length, 0, gateName);
            const combinedOutput = result.logs.join('\n');
            assert.ok(combinedOutput.includes(`gate ${gateName}`), gateName);
            assert.ok(combinedOutput.includes('Usage'), gateName);
            assert.ok(!combinedOutput.includes('TaskId must not be empty'), gateName);
            assert.ok(!combinedOutput.includes('ReviewType must not be empty'), gateName);
        }
    });

    it('documents every public gate in the CLI reference inventory', () => {
        const reference = fs.readFileSync(path.resolve('docs/cli-reference.md'), 'utf8');
        const inventory = reference.match(
            /### Dispatched gate inventory\n([\s\S]*?)\n### Gate invocation examples\n/
        );
        assert.ok(inventory, 'CLI reference must separate the complete inventory from selected examples');

        const documentedGates = [...inventory[1].matchAll(/^\| `([a-z][a-z-]+)` \|/gm)]
            .map(match => match[1]);
        assert.deepEqual(
            documentedGates.sort(),
            getAllShimmedGateNames().sort(),
            'the reference inventory must contain every dispatched gate exactly once and no unknown gates'
        );
        assert.ok(inventory[1].includes('`garda gate --help`'));
        assert.ok(inventory[1].includes('`garda gate <gate-name> --help`'));
    });

    it('prints canonical --task-id remediation for common task-start flag mistakes', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        const flagResult = await runCliWithCapturedOutput(['gate', 'enter-task-mode', '--task', 'T-008'], { cwd: sourceCheckoutNestedCwd });
        assert.notEqual(flagResult.exitCode, 0);
        const flagErrorOutput = flagResult.errors.join('\n');
        assert.ok(flagErrorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(flagErrorOutput.includes("uses '--task-id', not '--task'"));
        assert.ok(flagErrorOutput.includes('Suggested command: node bin/garda.js gate enter-task-mode --task-id "T-008"'));

        const equalsFlagResult = await runCliWithCapturedOutput(['gate', 'enter-task-mode', '--task=T-008'], { cwd: sourceCheckoutNestedCwd });
        assert.notEqual(equalsFlagResult.exitCode, 0);
        const equalsFlagErrorOutput = equalsFlagResult.errors.join('\n');
        assert.ok(equalsFlagErrorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(equalsFlagErrorOutput.includes("uses '--task-id', not '--task'"));
        assert.ok(equalsFlagErrorOutput.includes('Suggested command: node bin/garda.js gate enter-task-mode --task-id "T-008"'));

        const positionalResult = await runCliWithCapturedOutput(['gate', 'load-rule-pack', 'T-008'], { cwd: sourceCheckoutNestedCwd });
        assert.notEqual(positionalResult.exitCode, 0);
        const positionalErrorOutput = positionalResult.errors.join('\n');
        assert.ok(positionalErrorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(positionalErrorOutput.includes('requires \'--task-id "<task-id>"\', not a positional task id'));
        assert.ok(positionalErrorOutput.includes('Suggested command: node bin/garda.js gate load-rule-pack --task-id "T-008"'));

        const booleanPrefixedResult = await runCliWithCapturedOutput([
            'gate',
            'task-events-summary',
            '--as-json',
            'T-008'
        ], { cwd: sourceCheckoutNestedCwd });
        assert.notEqual(booleanPrefixedResult.exitCode, 0);
        const booleanPrefixedErrorOutput = booleanPrefixedResult.errors.join('\n');
        assert.ok(booleanPrefixedErrorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(booleanPrefixedErrorOutput.includes('requires \'--task-id "<task-id>"\', not a positional task id'));
        assert.ok(booleanPrefixedErrorOutput.includes('Suggested command: node bin/garda.js gate task-events-summary --task-id "T-008"'));

        const emitMetricsResult = await runCliWithCapturedOutput([
            'gate',
            'enter-task-mode',
            '--emit-metrics',
            'T-008'
        ], { cwd: sourceCheckoutNestedCwd });
        assert.notEqual(emitMetricsResult.exitCode, 0);
        const emitMetricsErrorOutput = emitMetricsResult.errors.join('\n');
        assert.ok(emitMetricsErrorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(emitMetricsErrorOutput.includes('requires \'--task-id "<task-id>"\', not a positional task id'));
        assert.ok(emitMetricsErrorOutput.includes('Suggested command: node bin/garda.js gate enter-task-mode --task-id "T-008"'));
    });

    it('prints canonical --task-id remediation for every gate that requires task-id syntax', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        for (const gateName of TASK_ID_REMEDIATION_GATE_NAMES) {
            const result = await runCliWithCapturedOutput(['gate', gateName, '--task=T-008'], { cwd: sourceCheckoutNestedCwd });
            assert.notEqual(result.exitCode, 0, gateName);
            const errorOutput = result.errors.join('\n');
            assert.ok(errorOutput.includes('GARDA_CLI_FAILED'), gateName);
            assert.ok(errorOutput.includes("uses '--task-id', not '--task'"), gateName);
            assert.ok(errorOutput.includes(`Canonical task-id syntax for '${gateName}'`), gateName);
            const expectedSuggestedCommand = gateName === 'next-step'
                ? 'Suggested command: node bin/garda.js next-step "T-008" --repo-root "."'
                : `Suggested command: node bin/garda.js gate ${gateName} --task-id "T-008"`;
            assert.ok(errorOutput.includes(expectedSuggestedCommand), gateName);
            const suggestedLine = errorOutput
                .split('\n')
                .find((line) => line.startsWith('Suggested command:')) ?? '';
            assert.ok(!suggestedLine.includes('<task-id>'), gateName);
        }
    });

    it('keeps source-checkout help and remediation snippets canonical from nested cwd values', async () => {
        const nestedSourceCwd = path.join(path.resolve('.'), 'src', 'cli');

        const helpResult = await runCliWithCapturedOutput(
            ['gate', 'enter-task-mode', '--help'],
            { cwd: nestedSourceCwd }
        );
        assert.equal(helpResult.exitCode, 0);
        const helpOutput = helpResult.logs.join('\n');
        assert.ok(helpOutput.includes('node bin/garda.js gate enter-task-mode --task-id "<task-id>"'));
        assert.ok(!helpOutput.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode'));

        const remediationResult = await runCliWithCapturedOutput(
            ['gate', 'enter-task-mode', '--task', 'T-008'],
            { cwd: nestedSourceCwd }
        );
        assert.notEqual(remediationResult.exitCode, 0);
        const remediationOutput = remediationResult.errors.join('\n');
        assert.ok(remediationOutput.includes('Suggested command: node bin/garda.js gate enter-task-mode --task-id "T-008"'));
        assert.ok(!remediationOutput.includes('Suggested command: node garda-agent-orchestrator/bin/garda.js'));
    });

    it('documents requested depth as a profile-driven optional override', async () => {
        const helpResult = await runCliWithCapturedOutput(
            ['gate', 'enter-task-mode', '--help'],
            { cwd: getSourceCheckoutNestedCwd() }
        );
        assert.equal(helpResult.exitCode, 0);
        const helpOutput = stripAnsi(helpResult.logs.join('\n'));
        assert.ok(helpOutput.includes('[--requested-depth "<1|2|3>"]'));
        assert.ok(helpOutput.includes('omit --requested-depth to use the selected task profile depth'));

        const overviewOutput = stripAnsi(buildGateCommandOverviewText(path.resolve('.')));
        assert.ok(!overviewOutput.includes('--requested-depth "2"'));
        assert.ok(overviewOutput.includes('gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --task-summary'));
    });

    it('uses deployed-workspace CLI prefixes for help and remediation outside a source checkout', () => {
        const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-help-bundle-'));
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const nestedCwd = path.join(workspaceRoot, 'packages', 'feature');

        fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
        fs.mkdirSync(nestedCwd, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '// test fixture\n', 'utf8');

        try {
            const helpOutput = stripAnsi(buildGateHelpText('enter-task-mode', nestedCwd));
            assert.ok(helpOutput.includes('node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "<task-id>"'));
            assert.ok(!helpOutput.includes('node bin/garda.js gate enter-task-mode --task-id "<task-id>"'));

            const remediationOutput = stripAnsi(buildTaskIdSyntaxRemediationMessage('enter-task-mode', ['--task=T-008'], nestedCwd) || '');
            assert.ok(remediationOutput);
            assert.ok(remediationOutput.includes('Suggested command: node garda-agent-orchestrator/bin/garda.js gate enter-task-mode --task-id "T-008"'));
        } finally {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('renders help paths with the fixed deployed bundle name', () => {
        const childEnv: NodeJS.ProcessEnv = {
            ...process.env,
            NO_COLOR: '1'
        };
        delete childEnv.FORCE_COLOR;
        const script = [
            "const path = require('node:path');",
            "const { pathToFileURL } = require('node:url');",
            '(async () => {',
            "    const modulePath = path.join(process.cwd(), '.node-build', 'src', 'cli', 'commands', 'gate-command-help.js');",
            '    const module = await import(pathToFileURL(modulePath).href);',
            '    const buildGateHelpText = module.buildGateHelpText || module.default?.buildGateHelpText;',
            "    process.stdout.write(buildGateHelpText('load-rule-pack', process.cwd()));",
            '})().catch((error) => {',
            "    console.error(error && error.stack ? error.stack : String(error));",
            '    process.exitCode = 1;',
            '});'
        ].join('\n');
        const result = childProcess.spawnSync(process.execPath, ['-e', script], {
            cwd: path.resolve('.'),
            env: childEnv,
            encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr);
        const helpOutput = stripAnsi(result.stdout);
        assert.ok(helpOutput.includes('garda-agent-orchestrator/live/docs/agent-rules/00-core.md'));
        assert.ok(helpOutput.includes('garda-agent-orchestrator/runtime/reviews/<task-id>-preflight.json'));
    });

    it('includes real-subagent hard-stop guidance in delegation-start help', () => {
        const helpOutput = stripAnsi(buildGateHelpText('record-reviewer-delegation-started', path.resolve('.')));

        assert.ok(helpOutput.includes('Launch a real subagent using built-in tools'));
        assert.ok(helpOutput.includes('if for some reason that is impossible right now, you must stop and report this to the user'));
        assert.ok(helpOutput.includes('this is expected behavior in this repository'));
        assert.ok(helpOutput.includes('Provider-owned placeholders are --reviewer-identity, --provider-invocation-id, and --attestation-source'));
        assert.ok(helpOutput.includes('--reviewer-identity "<agent:resolved-provider-reviewer-id-from-delegated-agent>"'));
        assert.ok(helpOutput.includes('--provider-invocation-id "<provider-owned invocation id from delegated reviewer launch result>"'));
        assert.ok(helpOutput.includes('--attestation-source "<provider-owned attestation source from delegated reviewer launch result>"'));
        assert.ok(helpOutput.includes('--launch-input-sha256 takes ReviewerLaunchInputArtifactSha256'));
        assert.ok(helpOutput.includes('launch_input_sha256 and launch_input_artifact_sha256 are artifact JSON fields'));
        assert.ok(helpOutput.includes('--launch-input-sha256 "<ReviewerLaunchInputArtifactSha256>"'));
        assert.ok(!helpOutput.includes('--launch-input-artifact-sha256'));
        assert.ok(helpOutput.includes('complete-reviewer-launch only after the reviewer returns'));
        assertNoDefaultReviewerReservationGuidance(helpOutput);
    });

    it('explains one-shot reviewer launch as the default in prepare launch help', () => {
        const helpOutput = stripAnsi(buildGateHelpText('prepare-reviewer-launch', path.resolve('.')));

        assert.ok(helpOutput.includes('launch one clean-context delegated reviewer with the exact CopyPasteReviewerLaunchPrompt or reviewer-facing ReviewerLaunchInputArtifactPath'));
        assert.ok(helpOutput.includes('ReviewerLaunchArtifactPath as main-agent control metadata only'));
        assertNoDefaultReviewerReservationGuidance(helpOutput);
    });

    it('includes provider invocation and launch-input evidence in complete launch help', () => {
        const helpOutput = stripAnsi(buildGateHelpText('complete-reviewer-launch', path.resolve('.')));

        assert.ok(helpOutput.includes('--reviewer-execution-mode "delegated_subagent"'));
        assert.ok(helpOutput.includes('--provider-invocation-id "<provider-owned invocation id from delegated reviewer launch result>"'));
        assert.ok(helpOutput.includes('--attestation-source "<provider-owned attestation source from delegated reviewer launch result>"'));
        assert.ok(helpOutput.includes('--launch-input-mode "launch_artifact_path"'));
        assert.ok(helpOutput.includes('--launch-input-artifact-path "garda-agent-orchestrator/runtime/tmp/reviews/<task-id>/<review-type>/reviewer-launch-input.json"'));
        assert.ok(helpOutput.includes('--launch-input-sha256 "<ReviewerLaunchInputArtifactSha256>"'));
        assert.ok(helpOutput.includes('--fork-context false'));
        assertNoDefaultReviewerReservationGuidance(helpOutput);
    });

    it('does not treat --help as a standalone help request when it is a string option value', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        const result = await runCliWithCapturedOutput([
            'gate',
            'validate-config',
            '--config-path',
            '--help'
        ], { cwd: sourceCheckoutNestedCwd });

        assert.notEqual(result.exitCode, 0);
        assert.equal(result.logs.length, 0);
        const errorOutput = result.errors.join('\n');
        assert.ok(errorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(!errorOutput.includes('Gate: validate-config'));
        assert.ok(errorOutput.includes('Unknown option: --config-path') || errorOutput.includes('ConfigPath'));
    });

    it('treats trailing --help after --task-id as gate help for malformed task-start invocations', async () => {
        const sourceCheckoutNestedCwd = getSourceCheckoutNestedCwd();
        const enterTaskModeResult = await runCliWithCapturedOutput([
            'gate',
            'enter-task-mode',
            '--task-id',
            '--help'
        ], { cwd: sourceCheckoutNestedCwd });
        assert.equal(enterTaskModeResult.exitCode, 0);
        assert.equal(enterTaskModeResult.errors.length, 0);
        const enterTaskModeOutput = enterTaskModeResult.logs.join('\n');
        assert.ok(enterTaskModeOutput.includes('gate enter-task-mode'));
        assert.ok(enterTaskModeOutput.includes('Usage'));
        assert.ok(!enterTaskModeOutput.includes('legacy_fallback'));

        const loadRulePackResult = await runCliWithCapturedOutput([
            'gate',
            'load-rule-pack',
            '--task-id',
            '--help'
        ], { cwd: sourceCheckoutNestedCwd });
        assert.equal(loadRulePackResult.exitCode, 0);
        assert.equal(loadRulePackResult.errors.length, 0);
        const loadRulePackOutput = loadRulePackResult.logs.join('\n');
        assert.ok(loadRulePackOutput.includes('gate load-rule-pack'));
        assert.ok(loadRulePackOutput.includes('Usage'));
        assert.ok(!loadRulePackOutput.includes('RULE_PACK_LOAD_FAILED'));
    });

    it('keeps POST_PREFLIGHT help generic instead of hardcoding one downstream rule-pack shape', async () => {
        const result = await runCliWithCapturedOutput(['gate', 'load-rule-pack', '--help'], { cwd: getSourceCheckoutNestedCwd() });
        assert.equal(result.exitCode, 0);
        const combinedOutput = result.logs.join('\n');
        assert.ok(combinedOutput.includes('<task-specific-downstream-rule-file>'));
        assert.ok(combinedOutput.includes('<additional-task-specific-rule-file>'));
        assert.ok(!combinedOutput.includes('50-structure-and-docs.md'));
        assert.ok(!combinedOutput.includes('70-security.md'));
    });

    it('does not emit task-id remediation for gates that do not accept --task-id', async () => {
        const result = await runCliWithCapturedOutput(['gate', 'build-review-context', 'T-008'], { cwd: getSourceCheckoutNestedCwd() });
        assert.notEqual(result.exitCode, 0);
        const errorOutput = result.errors.join('\n');
        assert.ok(errorOutput.includes('GARDA_CLI_FAILED'));
        assert.ok(errorOutput.includes('Unexpected positional argument: T-008'));
        assert.ok(!errorOutput.includes('Canonical task-id syntax'));
        assert.ok(!errorOutput.includes('Suggested command:'));
    });

    it('lists every public gate in root gate help output', async () => {
        const result = await runCliWithCapturedOutput(['gate', '--help'], { cwd: getSourceCheckoutNestedCwd() });
        assert.equal(result.exitCode, 0);
        assert.equal(result.errors.length, 0);
        const combinedOutput = result.logs.join('\n');
        assert.ok(combinedOutput.includes('record-no-op'));
        assert.ok(combinedOutput.includes('run-intermediate-command'));
        assert.ok(combinedOutput.includes('task-audit-summary'));
    });

    it('record-no-op help uses accepted classifications', async () => {
        const result = await runCliWithCapturedOutput(['gate', 'record-no-op', '--help'], { cwd: getSourceCheckoutNestedCwd() });
        assert.equal(result.exitCode, 0);
        const combinedOutput = result.logs.join('\n');
        assert.ok(combinedOutput.includes('--classification "AUDIT_ONLY"'));
        assert.ok(combinedOutput.includes('NO_CHANGES_REQUIRED|ALREADY_DONE|AUDIT_ONLY'));
        assert.ok(!combinedOutput.includes('--classification "BASELINE_ONLY"'));
    });

    it('documents the guarded expected-red intermediate command contract', async () => {
        const result = await runCliWithCapturedOutput(
            ['gate', 'run-intermediate-command', '--help'],
            { cwd: getSourceCheckoutNestedCwd() }
        );
        assert.equal(result.exitCode, 0);
        const combinedOutput = stripAnsi(result.logs.join('\n'));
        assert.ok(combinedOutput.includes('--expect-failure'));
        assert.ok(combinedOutput.includes('Test-first: expected-red'));
        assert.ok(combinedOutput.includes('unexpected pass'));
        assert.ok(combinedOutput.includes('test-only preflight'));
    });

    it('quality-checklist help does not advertise a partial default-rule answer set', async () => {
        const result = await runCliWithCapturedOutput(['gate', 'quality-checklist', '--help'], { cwd: getSourceCheckoutNestedCwd() });
        assert.equal(result.exitCode, 0);
        const combinedOutput = stripAnsi(result.logs.join('\n'));
        assert.ok(combinedOutput.includes('one answer object per active rule for the current preflight scope'));
        assert.ok(combinedOutput.includes('PowerShell-safe JSON input'));
        assert.ok(combinedOutput.includes('navigator materializes or refreshes'));
        assert.equal(combinedOutput.includes('--prepare-answers-template'), false);
        assert.ok(combinedOutput.includes('--answers-path "garda-agent-orchestrator/runtime/tmp/<task-id>-quality-checklist-answers.json"'));
        assert.ok(combinedOutput.includes('Get-Content -Raw -LiteralPath "garda-agent-orchestrator/runtime/tmp/<task-id>-quality-checklist-answers.json"'));
        assert.ok(combinedOutput.includes('--answers-stdin'));
        assert.equal(combinedOutput.includes('one answer object per enabled rule'), false);
        assert.ok(combinedOutput.includes('<JSON array with one answer object per active optional_quality_checks rule for the current preflight scope>'));
        assert.equal(combinedOutput.includes('"rule_id":"code_simplification"'), false);
    });
});
