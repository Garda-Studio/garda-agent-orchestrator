import * as path from 'node:path';
import {
    buildBundleRelativePath as buildCoreBundleRelativePath,
    getBundleCliCommand,
    getSourceCliCommand,
    isBundleRootLike,
    resolveBundleNameForTarget
} from '../../core/constants';
import { isOrchestratorSourceCheckout } from '../../gates/shared/helpers';
import { bold, cyan, dim, green, styleHelpCommandLine } from './cli-format-output';

interface GateHelpEntry {
    summary: string;
    usage: readonly string[];
    taskIdRemediation: boolean;
}

interface GateHelpCatalogContext {
    bundleName: string;
    cliPrefix: string;
}

export interface GateHelpInfo {
    summary: string;
    usage: readonly string[];
}

const TASK_ID_PLACEHOLDER = '<task-id>';
const TASK_ID_POSITIONAL_RE = /^T-[A-Z0-9-]+$/i;
const BOOLEAN_GATE_OPTIONS = new Set([
    '--allow-plan-drift',
    '--as-json',
    '--answers-stdin',
    '--behavior-changed',
    '--changelog-updated',
    '--clear-dead-marker',
    '--compact',
    '--confirm',
    '--confirm-updated',
    '--discard',
    '--dry-run',
    '--emit-metrics',
    '--hunk-level',
    '--include-details',
    '--include-untracked',
    '--orchestrator-work',
    '--reopen',
    '--review-output-stdin',
    '--sensitive-reviewed',
    '--sensitive-scope-reviewed',
    '--use-staged',
    '--workflow-config-work'
]);
const HELP_PREFERRED_VALUE_OPTIONS = new Set([
    '--task-id'
]);

function createGateHelpEntry(
    summary: string,
    usage: readonly string[],
    taskIdRemediation: boolean
): GateHelpEntry {
    return {
        summary,
        usage: Object.freeze([...usage]),
        taskIdRemediation
    };
}

function createSingleUsageEntry(
    summary: string,
    usage: string,
    taskIdRemediation: boolean
): GateHelpEntry {
    return createGateHelpEntry(summary, [usage], taskIdRemediation);
}

function buildCliPrefix(repoRoot: string): string {
    return isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
}

function resolveGateHelpRepoRoot(startDir: string): string {
    let current = path.resolve(startDir);
    for (let index = 0; index < 20; index += 1) {
        if (isOrchestratorSourceCheckout(current)) {
            return current;
        }
        const bundleRoot = path.join(current, resolveBundleNameForTarget(current));
        if (isBundleRootLike(bundleRoot)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return path.resolve(startDir);
}

function buildBundleRelativePath(bundleName: string, relativePath: string): string {
    return buildCoreBundleRelativePath(relativePath, bundleName);
}

function buildGateHelpCatalogContext(repoRoot: string): GateHelpCatalogContext {
    return {
        bundleName: resolveBundleNameForTarget(repoRoot),
        cliPrefix: buildCliPrefix(repoRoot)
    };
}

function buildTaskEntryRulePackSnippet(cliPrefix: string, bundleName: string): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        '--task-id "<task-id>"',
        '--stage "TASK_ENTRY"',
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/00-core.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/15-project-memory.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/40-commands.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/80-task-workflow.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/90-skill-catalog.md')}"`,
        '--repo-root "."'
    ].join(' ');
}

function buildPostPreflightRulePackSnippet(cliPrefix: string, bundleName: string): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        '--task-id "<task-id>"',
        '--stage "POST_PREFLIGHT"',
        `--preflight-path "${buildBundleRelativePath(bundleName, 'runtime/reviews/<task-id>-preflight.json')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/00-core.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/15-project-memory.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/40-commands.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/80-task-workflow.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(bundleName, 'live/docs/agent-rules/90-skill-catalog.md')}"`,
        '--loaded-rule-file "<task-specific-downstream-rule-file>"',
        '--loaded-rule-file "<additional-task-specific-rule-file>"',
        '--repo-root "."'
    ].join(' ');
}

function buildPreflightGateHelpEntries(
    cliPrefix: string,
    bundleName: string
): Record<string, GateHelpEntry> {
    return {
        'validate-manifest': {
            ...createGateHelpEntry('Validate MANIFEST.md for traversal, duplicates, and out-of-root entries.', [
                `${cliPrefix} gate validate-manifest --manifest-path "${buildBundleRelativePath(bundleName, 'MANIFEST.md')}"`,
                `${cliPrefix} gate validate-manifest --manifest-path "<manifest-path>" --repo-root "."`
            ], false)
        },
        'validate-config': {
            ...createGateHelpEntry('Validate the managed Garda JSON config set referenced by garda.config.json.', [
                `${cliPrefix} gate validate-config`,
                `${cliPrefix} gate validate-config --bundle-root "${bundleName}"`,
                `${cliPrefix} gate validate-config --compact`
            ], false)
        },
        'enter-task-mode': {
            ...createSingleUsageEntry(
                'Enter explicit task mode before any implementation, with runtime identity pinned through explicit provider selection; omit --requested-depth to use the selected task profile depth, or pass it as an explicit operator override.',
                `${cliPrefix} gate enter-task-mode --task-id "${TASK_ID_PLACEHOLDER}" --entry-mode "EXPLICIT_TASK_EXECUTION" [--requested-depth "<1|2|3>"] --task-summary "<task summary>" --provider "<provider>" [--routed-to "<provider-bridge-or-entrypoint>"] [--start-banner "<repo-owned-marker>"] [--orchestrator-work [--workflow-config-work] [--upgrade-existing-task-mode] --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"] --repo-root "."`,
                true
            )
        },
        'recover-task-mode-protected-manifest': {
            ...createSingleUsageEntry(
                'Repair a protected manifest only after a persisted task-mode entry failure and fresh explicit operator confirmation; writes before/after recovery evidence and returns a fresh enter-task-mode command.',
                `${cliPrefix} gate recover-task-mode-protected-manifest --task-id "${TASK_ID_PLACEHOLDER}" --inspected-protected-snapshot-sha256 "<sha256-from-failure>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --repo-root "."`,
                true
            )
        },
        'load-rule-pack': {
            ...createGateHelpEntry('Record the exact mandatory downstream rule files opened for the current task cycle. Do not include optional support appendices such as live/docs/agent-rules/40-command-reference.md; open that appendix only on demand for tool-specific command tables.', [
                buildTaskEntryRulePackSnippet(cliPrefix, bundleName),
                buildPostPreflightRulePackSnippet(cliPrefix, bundleName)
            ], true)
        },
        'bind-rule-pack-to-preflight': {
            ...createGateHelpEntry(
                'Rebind already-loaded POST_PREFLIGHT rule-pack evidence to the latest equivalent preflight without asking the agent to reread rule files.',
                [
                    `${cliPrefix} gate bind-rule-pack-to-preflight --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`,
                    `${cliPrefix} gate bind-rule-pack-to-preflight --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --task-mode-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-task-mode.json`)}" --repo-root "."`
                ],
                true
            )
        },
        'record-no-op': {
            ...createGateHelpEntry(
                'Record an audited no-op classification when the task intentionally produces no code changes.',
                [
                    `${cliPrefix} gate record-no-op --task-id "${TASK_ID_PLACEHOLDER}" --classification "AUDIT_ONLY" --reason "<why no code changed>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`,
                    `${cliPrefix} gate record-no-op --task-id "${TASK_ID_PLACEHOLDER}" --classification "<NO_CHANGES_REQUIRED|ALREADY_DONE|AUDIT_ONLY>" --reason "<why no code changed>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`
                ],
                true
            )
        },
        'record-review-cycle-continuation': {
            ...createSingleUsageEntry(
                'Record an operator-approved one-shot review-cycle continuation for the current task without mutating workflow-config.json.',
                `${cliPrefix} gate record-review-cycle-continuation --task-id "${TASK_ID_PLACEHOLDER}" --decision "allow_one_more_cycle" --baseline-total-non-test-reviews "<current total>" --baseline-failed-non-test-reviews "<current failed>" --max-total-non-test-reviews "<configured total limit>" --max-failed-non-test-reviews "<configured failed limit>" --excluded-review-types "test" --reason "<operator-approved reason>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --repo-root "."`,
                true
            )
        },
        'record-review-cycle-split-decision': {
            ...createSingleUsageEntry(
                'Record an operator-approved review-cycle split decision, move the parent to SPLIT_REQUIRED, and write latch evidence without mutating workflow-config.json.',
                `${cliPrefix} gate record-review-cycle-split-decision --task-id "${TASK_ID_PLACEHOLDER}" --decision "split_task" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --baseline-total-non-test-reviews "<current total>" --baseline-failed-non-test-reviews "<current failed>" --max-total-non-test-reviews "<configured total limit>" --max-failed-non-test-reviews "<configured failed limit>" --excluded-review-types "test" --reason "<operator-approved reason>" --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --repo-root "."`,
                true
            )
        },
        'record-strict-decomposition-decision': {
            ...createGateHelpEntry(
                'Record the prompt-first decomposition decision for a risky strict task before implementation.',
                [
                    `${cliPrefix} gate record-strict-decomposition-decision --task-id "${TASK_ID_PLACEHOLDER}" --decision "<atomic|single-cycle>" --task-summary "<task summary>" --reason "<why this decision is correct>" --scope-risk "<scope/risk summary>" --expected-review-type "<code|db|security|refactor|api|test|performance|infra|dependency|none>" --atomicity-constraint "<constraint or none>" --repo-root "."`,
                    `${cliPrefix} gate record-strict-decomposition-decision --task-id "${TASK_ID_PLACEHOLDER}" --decision "split-required" --task-summary "<task summary>" --reason "<why split is required>" --scope-risk "<scope/risk summary>" --expected-review-type "code" --atomicity-constraint "<what must stay together>" --work-package-contract-path "<root-cause-work-package-contract.json>" --repo-root "."`
                ],
                true
            )
        },
        'list-split-required-wip': {
            ...createSingleUsageEntry(
                'List task-owned WIP manifests captured when a parent was moved to SPLIT_REQUIRED.',
                `${cliPrefix} gate list-split-required-wip --task-id "${TASK_ID_PLACEHOLDER}" --repo-root "."`,
                true
            )
        },
        'restore-split-required-wip': {
            ...createGateHelpEntry(
                'Preview or explicitly restore a full or selected subset of captured split-required parent WIP, refusing stale-base, dirty-workspace, and target conflicts.',
                [
                    `${cliPrefix} gate restore-split-required-wip --task-id "${TASK_ID_PLACEHOLDER}" --manifest-path "${buildBundleRelativePath(bundleName, `runtime/wip/${TASK_ID_PLACEHOLDER}/split-required/<timestamp>/manifest.json`)}" --dry-run --repo-root "."`,
                    `${cliPrefix} gate restore-split-required-wip --task-id "${TASK_ID_PLACEHOLDER}" --manifest-path "${buildBundleRelativePath(bundleName, `runtime/wip/${TASK_ID_PLACEHOLDER}/split-required/<timestamp>/manifest.json`)}" --include-path "src/<file>.ts" --dry-run --repo-root "."`,
                    `${cliPrefix} gate restore-split-required-wip --task-id "${TASK_ID_PLACEHOLDER}" --manifest-path "${buildBundleRelativePath(bundleName, `runtime/wip/${TASK_ID_PLACEHOLDER}/split-required/<timestamp>/manifest.json`)}" --include-path "src/<file>.ts" --repo-root "."`
                ],
                false
            )
        },
        'retire-split-required-wip': {
            ...createSingleUsageEntry(
                'Mark a captured split-required WIP manifest retired after child scopes no longer need it.',
                `${cliPrefix} gate retire-split-required-wip --task-id "${TASK_ID_PLACEHOLDER}" --manifest-path "${buildBundleRelativePath(bundleName, `runtime/wip/${TASK_ID_PLACEHOLDER}/split-required/<timestamp>/manifest.json`)}" --reason "<why this WIP is no longer needed>" --repo-root "."`,
                false
            )
        },
        'handshake-diagnostics': {
            ...createSingleUsageEntry(
                'Verify runtime identity, reviewer-subagent launchability, router presence, and CLI path before preflight.',
                `${cliPrefix} gate handshake-diagnostics --task-id "${TASK_ID_PLACEHOLDER}" --repo-root "."`,
                true
            )
        },
        'shell-smoke-preflight': {
            ...createSingleUsageEntry(
                'Run lightweight launchability and filesystem probes before classify-change.',
                `${cliPrefix} gate shell-smoke-preflight --task-id "${TASK_ID_PLACEHOLDER}" --repo-root "."`,
                true
            )
        },
        'command-timeout-diagnostics': {
            ...createSingleUsageEntry(
                'Inspect command timeout records for the active task/runtime identity.',
                `${cliPrefix} gate command-timeout-diagnostics --task-id "${TASK_ID_PLACEHOLDER}" --repo-root "."`,
                true
            )
        },
        'quality-checklist': {
            ...createGateHelpEntry(
                'Record the configured optional quality checklist as machine-readable advisory gate evidence; answers input must include one answer object per active rule for the current preflight scope. Prefer --answers-path or --answers-stdin for PowerShell-safe JSON input. The navigator materializes or refreshes the bound --answers-path for the active preflight questions before printing this command. Use ACTION_REQUIRED only for follow-up the implementation agent should address before compile/review/full-suite; this gate never replaces reviewer receipts.',
                [
                    `${cliPrefix} gate quality-checklist --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --answers-path "${buildBundleRelativePath(bundleName, `runtime/tmp/${TASK_ID_PLACEHOLDER}-quality-checklist-answers.json`)}" --repo-root "."`,
                    `Get-Content -Raw -LiteralPath "${buildBundleRelativePath(bundleName, `runtime/tmp/${TASK_ID_PLACEHOLDER}-quality-checklist-answers.json`)}" | ${cliPrefix} gate quality-checklist --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --answers-stdin --repo-root "."`,
                    `${cliPrefix} gate quality-checklist --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --answers-json "<JSON array with one answer object per active optional_quality_checks rule for the current preflight scope>" --repo-root "."`
                ],
                true
            )
        },
        'run-intermediate-command': {
            ...createGateHelpEntry(
                'Run an opt-in auditable intermediate validation command with full raw output artifact and compact visible output. --expect-failure is restricted to an exact TASK.md Notes marker "Test-first: expected-red", a current test-only preflight, and a focused changed test; a real nonzero test exit is recorded as successful expected-red evidence, while timeout, cancellation, or an unexpected pass fails closed.',
                [
                    `${cliPrefix} gate run-intermediate-command --task-id "${TASK_ID_PLACEHOLDER}" --command-source "<node-test|targeted-test|typecheck|validation>" --command "<validation command>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --coverage-contract-sha256 "<coverage contract sha256>" --repo-root "."`,
                    `${cliPrefix} gate run-intermediate-command --task-id "${TASK_ID_PLACEHOLDER}" --command-source "<node-test|targeted-test>" --command "<focused changed test command>" --expect-failure --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`
                ],
                true
            )
        },
        'classify-change': {
            ...createGateHelpEntry('Classify the intended scope before implementation and determine required review types.', [
                `${cliPrefix} gate classify-change --task-id "${TASK_ID_PLACEHOLDER}" --task-intent "<task summary>" --changed-file "src/<file>" --output-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`,
                `${cliPrefix} gate classify-change --task-id "${TASK_ID_PLACEHOLDER}" --task-intent "<task summary>" --use-staged --output-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`
            ], true)
        },
        'restart-coherent-cycle': {
            ...createSingleUsageEntry(
                'Refresh preflight and downstream compile evidence for the current task after scope drift. This reruns the configured compile gate and can take the full project compile duration. Confirmation flags are required when re-entering protected task mode requires fresh operator approval; an ordinary unprotected restart does not require them. Follow next-step for the applicable command.',
                `${cliPrefix} gate restart-coherent-cycle --task-id "${TASK_ID_PLACEHOLDER}" --task-intent "<task summary>" --changed-file "src/<file>" [--operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>"] --repo-root "."`,
                true
            )
        },
        'restart-review-cycle': {
            ...createSingleUsageEntry(
                'Refresh failed-review remediation evidence after a small blocker fix, requiring main-agent impact analysis and preserving review reuse boundaries.',
                `${cliPrefix} gate restart-review-cycle --task-id "${TASK_ID_PLACEHOLDER}" --task-intent "<task summary>" --changed-file "src/<file>" --impact-analysis "<replace with main-agent remediation impact analysis>" --repo-root "."`,
                true
            )
        },
        'compile-gate': {
            ...createGateHelpEntry('Run the mandatory compile/build/type-check commands selected by the guarded compile flow; full test suites belong to full-suite-validation.', [
                `${cliPrefix} gate compile-gate --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`,
                `${cliPrefix} gate compile-gate --task-id "${TASK_ID_PLACEHOLDER}" --allow-full-test-compile-command --allow-full-test-compile-command-reason "<operator-approved reason>" --repo-root "."`
            ], true)
        },
        'build-scoped-diff': {
            ...createSingleUsageEntry(
                'Materialize a review-type-specific scoped diff plus metadata for downstream reviewers.',
                `${cliPrefix} gate build-scoped-diff --review-type "<db|security|refactor|api|test|performance|infra|dependency>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --output-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-scoped.diff`)}" --repo-root "."`,
                false
            )
        },
        'build-review-context': {
            ...createSingleUsageEntry(
                'Prepare reviewer rule context and emit mandatory review-skill telemetry before a review run.',
                `${cliPrefix} gate build-review-context --review-type "<code|db|security|refactor|api|test|performance|infra|dependency>" --depth "<1|2|3>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" [--focused-required-test-path "tests/<target>.test.ts"] --repo-root "."`,
                false
            )
        },
        'activate-optional-skill': {
            ...createSingleUsageEntry(
                'Validate and record a selected optional skill activation before opening its SKILL.md for implementation work.',
                `${cliPrefix} gate activate-optional-skill --task-id "${TASK_ID_PLACEHOLDER}" --skill-id "<selected-skill-id>" --repo-root "."`,
                true
            )
        },
        'decline-optional-skill': {
            ...createSingleUsageEntry(
                'Validate and record deliberate non-use of a selected advisory optional skill for the current task cycle.',
                `${cliPrefix} gate decline-optional-skill --task-id "${TASK_ID_PLACEHOLDER}" --skill-id "<selected-skill-id>" --reason "<why-not-used>" --repo-root "."`,
                true
            )
        }
    };
}

function buildReviewGateHelpEntries(
    cliPrefix: string,
    bundleName: string
): Record<string, GateHelpEntry> {
    return {
        'required-reviews-check': {
            ...createSingleUsageEntry(
                'Validate that every required current-cycle review artifact and receipt is present and clean; when required reviews exist, include a strict boolean authorship attestation JSON object. Leave false unless you personally observed real delegated subagent review output/receipt; true after self-authored, fabricated, substituted, absent, or uncertain review provenance is a critical workflow violation.',
                `${cliPrefix} gate required-reviews-check --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --review-authorship-attestation-json '{"code":false}' --repo-root "."`,
                true
            )
        },
        'doc-impact-gate': {
            ...createSingleUsageEntry(
                'Record documentation impact evidence before completion.',
                `${cliPrefix} gate doc-impact-gate --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --decision "NO_DOC_UPDATES" --behavior-changed false --changelog-updated false --internal-changelog-updated false --project-memory-updated false --rationale "<why>" --repo-root "."`,
                true
            )
        },
        'record-review-result': {
            ...createSingleUsageEntry(
                'Materialize exact delegated reviewer output from stdin into canonical raw-output artifacts, receipts, and routing telemetry; close or release the delegated reviewer after the receipt persists.',
                `${cliPrefix} gate record-review-result --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --review-output-stdin --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent:...>" --repo-root "."`,
                true
            )
        },
        'record-review-routing': {
            ...createSingleUsageEntry(
                'Record reviewer routing metadata for a prepared review context.',
                `${cliPrefix} gate record-review-routing --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --review-context-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-review-context.json`)}" --reviewer-execution-mode "delegated_subagent" --repo-root "."`,
                true
            )
        },
        'prepare-reviewer-launch': {
            ...createSingleUsageEntry(
                'Prepare task-owned delegated reviewer launch metadata from the current routing event and review context; this is not completed invocation evidence. Omit --reviewer-identity to let the gate assign a planned pending identity before provider launch. After preparation, launch one clean-context delegated reviewer with the exact CopyPasteReviewerLaunchPrompt or reviewer-facing ReviewerLaunchInputArtifactPath; keep ReviewerLaunchArtifactPath as main-agent control metadata only. Then record reviewer delegation start with the resolved provider reviewer identity before the reviewer returns; do not create, reserve, hold, or complete a reviewer before launch input exists.',
                `${cliPrefix} gate prepare-reviewer-launch --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --review-context-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-review-context.json`)}" --reviewer-execution-mode "delegated_subagent" --reviewer-launch-artifact-path "${buildBundleRelativePath(bundleName, `runtime/tmp/reviews/${TASK_ID_PLACEHOLDER}/<review-type>/reviewer-launch.json`)}" --repo-root "."`,
                true
            )
        },
        'record-reviewer-delegation-started': {
            ...createSingleUsageEntry(
                'Record the real delegated reviewer start immediately after launching the provider sub-agent; this owns the user-visible review duration start timestamp. Launch a real subagent using built-in tools with the reviewer-facing ReviewerLaunchInputArtifactPath or CopyPasteReviewerLaunchPrompt; if for some reason that is impossible right now, you must stop and report this to the user; this is expected behavior in this repository. Provider-owned placeholders are --reviewer-identity, --provider-invocation-id, and --attestation-source; replace them with the delegated reviewer launch result after provider launch. For launch_artifact_path mode, --launch-input-sha256 takes ReviewerLaunchInputArtifactSha256; launch_input_sha256 and launch_input_artifact_sha256 are artifact JSON fields, not extra CLI flags. Run complete-reviewer-launch only after the reviewer returns.',
                `${cliPrefix} gate record-reviewer-delegation-started --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --review-context-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-review-context.json`)}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent:resolved-provider-reviewer-id-from-delegated-agent>" --reviewer-launch-artifact-path "${buildBundleRelativePath(bundleName, `runtime/tmp/reviews/${TASK_ID_PLACEHOLDER}/<review-type>/reviewer-launch.json`)}" --provider-invocation-id "<provider-owned invocation id from delegated reviewer launch result>" --attestation-source "<provider-owned attestation source from delegated reviewer launch result>" --launch-input-mode "launch_artifact_path" --launch-input-artifact-path "${buildBundleRelativePath(bundleName, `runtime/tmp/reviews/${TASK_ID_PLACEHOLDER}/<review-type>/reviewer-launch-input.json`)}" --launch-input-sha256 "<ReviewerLaunchInputArtifactSha256>" --fork-context false --repo-root "."`,
                true
            )
        },
        'record-reviewer-launch-failed': {
            ...createSingleUsageEntry(
                'Terminally mark the current immutable delegation-started reviewer launch attempt as failed before audited review-cycle recovery. The reviewer identity, invocation id, context, routing, and attempt id must match the current launch artifact exactly.',
                `${cliPrefix} gate record-reviewer-launch-failed --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --review-context-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-review-context.json`)}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent:...>" --reviewer-launch-artifact-path "${buildBundleRelativePath(bundleName, `runtime/tmp/reviews/${TASK_ID_PLACEHOLDER}/<review-type>/reviewer-launch.json`)}" --provider-invocation-id "<provider-owned invocation id>" --failure-reason "<provider/controller failure reason>" --repo-root "."`,
                true
            )
        },
        'complete-reviewer-launch': {
            ...createSingleUsageEntry(
                'Complete reviewer launch metadata after the delegated reviewer returns; this records completion/finalization and must not redefine the reviewer start timestamp. For launch_artifact_path mode, reuse the same ReviewerLaunchInputArtifactSha256 passed to record-reviewer-delegation-started. The attestation-source placeholder remains provider-owned and must be replaced with the provider launch result.',
                `${cliPrefix} gate complete-reviewer-launch --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --review-context-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-review-context.json`)}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent:...>" --reviewer-launch-artifact-path "${buildBundleRelativePath(bundleName, `runtime/tmp/reviews/${TASK_ID_PLACEHOLDER}/<review-type>/reviewer-launch.json`)}" --provider-invocation-id "<provider-owned invocation id from delegated reviewer launch result>" --attestation-source "<provider-owned attestation source from delegated reviewer launch result>" --launch-input-mode "launch_artifact_path" --launch-input-artifact-path "${buildBundleRelativePath(bundleName, `runtime/tmp/reviews/${TASK_ID_PLACEHOLDER}/<review-type>/reviewer-launch-input.json`)}" --launch-input-sha256 "<ReviewerLaunchInputArtifactSha256>" --fork-context false --record-invocation --repo-root "."`,
                true
            )
        },
        'record-review-invocation': {
            ...createSingleUsageEntry(
                'Record delegated reviewer launch attestation from a completed task-owned provider launch artifact.',
                `${cliPrefix} gate record-review-invocation --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --review-context-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-review-context.json`)}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent:...>" --reviewer-launch-artifact-path "${buildBundleRelativePath(bundleName, `runtime/tmp/reviews/${TASK_ID_PLACEHOLDER}/<review-type>/reviewer-launch.json`)}" --repo-root "."`,
                true
            )
        },
        'record-review-receipt': {
            ...createSingleUsageEntry(
                'Record a review receipt when verdict capture and routing were completed externally; close or release the delegated reviewer after the receipt persists.',
                `${cliPrefix} gate record-review-receipt --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "<agent:...>" --repo-root "."`,
                true
            )
        },
        'materialize-review-follow-up-tasks': {
            ...createGateHelpEntry(
                'Materialize idempotent F-suffixed backlog tasks from accepted review_findings_disposition and validation artifacts, carrying severity, evidence, remediation, receipt hashes, validation hashes, and a stable fingerprint.',
                [
                    `${cliPrefix} gate materialize-review-follow-up-tasks --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --disposition-artifact-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-findings-disposition.json`)}" --repo-root "."`,
                    `${cliPrefix} gate materialize-review-follow-up-tasks --task-id "${TASK_ID_PLACEHOLDER}" --review-type "<review-type>" --disposition-artifact-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-findings-disposition.json`)}" --receipt-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-receipt.json`)}" --artifact-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-<review-type>-findings-follow-ups.json`)}" --repo-root "."`
                ],
                true
            )
        }
    };
}

function buildLifecycleGateHelpEntries(
    cliPrefix: string,
    bundleName: string
): Record<string, GateHelpEntry> {
    return {
        'completion-gate': {
            ...createSingleUsageEntry(
                'Validate final lifecycle evidence and mark the task DONE only after all mandatory gates passed.',
                `${cliPrefix} gate completion-gate --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`,
                true
            )
        },
        'full-suite-validation': {
            ...createSingleUsageEntry(
                'Run repository-wide test suite as part of mandatory closeout (when enabled). Enable it through workflow set --full-suite-enabled true --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" after operator approval. Follow next-step for the configured full-suite placement; do not edit workflow-config.json directly.',
                `${cliPrefix} gate full-suite-validation --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`,
                true
            )
        },
        'full-suite-run-marker-recovery': {
            ...createGateHelpEntry(
                'Inspect an interrupted full-suite run marker and clear only dead current-cycle markers after explicit confirmation.',
                [
                    `${cliPrefix} gate full-suite-run-marker-recovery --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`,
                    `${cliPrefix} gate full-suite-run-marker-recovery --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --clear-dead-marker --operator-confirmed yes --repo-root "."`
                ],
                true
            )
        },
        'materialize-full-suite-repair-task': {
            ...createSingleUsageEntry(
                'Validate an audited two-or-more-child repair handoff for an exhausted full-suite timeout blocker, suspend task-owned parent WIP, and latch the parent as split-required.',
                `${cliPrefix} gate materialize-full-suite-repair-task --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --full-suite-artifact-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-full-suite-validation.json`)}" --repo-root "."`,
                true
            )
        },
        'restore-full-suite-repair-wip': {
            ...createGateHelpEntry(
                'Restore a previously suspended parent WIP manifest after every linked repair child completes, refusing stale-base or dirty-workspace conflicts.',
                [
                    `${cliPrefix} gate restore-full-suite-repair-wip --task-id "${TASK_ID_PLACEHOLDER}" --full-suite-artifact-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-full-suite-validation.json`)}" --manifest-path "${buildBundleRelativePath(bundleName, `runtime/wip/${TASK_ID_PLACEHOLDER}/full-suite-repair/<timestamp>/manifest.json`)}" --dry-run --repo-root "."`,
                    `${cliPrefix} gate restore-full-suite-repair-wip --task-id "${TASK_ID_PLACEHOLDER}" --full-suite-artifact-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-full-suite-validation.json`)}" --manifest-path "${buildBundleRelativePath(bundleName, `runtime/wip/${TASK_ID_PLACEHOLDER}/full-suite-repair/<timestamp>/manifest.json`)}" --repo-root "."`
                ],
                false
            )
        },
        'project-memory-impact': {
            ...createGateHelpEntry('Assess whether durable project-memory files need manual updates for the current task scope.', [
                `${cliPrefix} gate project-memory-impact --task-id "${TASK_ID_PLACEHOLDER}" --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`,
                `${cliPrefix} gate project-memory-impact --task-id "${TASK_ID_PLACEHOLDER}" --confirm-updated --updated-memory-file "${buildBundleRelativePath(bundleName, 'live/docs/project-memory/module-map.md')}" --updated-memory-file "${buildBundleRelativePath(bundleName, 'live/docs/project-memory/compact.md')}" --repo-root "."`
            ], true)
        },
        'log-task-event': {
            ...createSingleUsageEntry(
                'Append a structured lifecycle event to the current task timeline.',
                `${cliPrefix} gate log-task-event --task-id "${TASK_ID_PLACEHOLDER}" --event-type "PLAN_CREATED" --outcome "INFO" --message "<message>" --actor "orchestrator" --repo-root "."`,
                true
            )
        },
        'task-events-summary': {
            ...createGateHelpEntry('Summarize task timeline events for audit and debugging.', [
                `${cliPrefix} gate task-events-summary --task-id "${TASK_ID_PLACEHOLDER}" --repo-root "."`,
                `${cliPrefix} gate task-events-summary --task-id "${TASK_ID_PLACEHOLDER}" --as-json --repo-root "."`,
                `${cliPrefix} gate task-events-summary --task-id "${TASK_ID_PLACEHOLDER}" --compact-latest-cycle --repo-root "."`
            ], true)
        },
        'task-audit-summary': {
            ...createGateHelpEntry('Build the final gate audit summary, including canonical final-closeout artifacts on PASS.', [
                `${cliPrefix} gate task-audit-summary --task-id "${TASK_ID_PLACEHOLDER}" --repo-root "."`,
                `${cliPrefix} gate task-audit-summary --task-id "${TASK_ID_PLACEHOLDER}" --as-json --repo-root "."`
            ], true)
        },
        'next-step': {
            ...createGateHelpEntry('Default task-loop navigator: show the single next orchestrator command, effective full-suite config, review launchable batch, blocked lanes, and legacy NextReview compatibility.', [
                `${cliPrefix} next-step "${TASK_ID_PLACEHOLDER}" --repo-root "."`,
                `${cliPrefix} gate next-step "${TASK_ID_PLACEHOLDER}" --repo-root "."`,
                `${cliPrefix} gate next-step --task-id "${TASK_ID_PLACEHOLDER}" --repo-root "."`,
                `${cliPrefix} gate next-step --task-id "${TASK_ID_PLACEHOLDER}" --as-json --repo-root "."`,
                `${cliPrefix} gate next-step --preflight-path "${buildBundleRelativePath(bundleName, `runtime/reviews/${TASK_ID_PLACEHOLDER}-preflight.json`)}" --repo-root "."`,
                `${cliPrefix} gate next-step --task-id "${TASK_ID_PLACEHOLDER}" --events-root "${buildBundleRelativePath(bundleName, 'runtime/task-events')}" --reviews-root "${buildBundleRelativePath(bundleName, 'runtime/reviews')}" --repo-root "."`
            ], true)
        },
        'human-commit': {
            ...createSingleUsageEntry(
                'Run a commit through the guarded helper path only after explicit operator yes/no confirmation.',
                `${cliPrefix} gate human-commit --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>" --message "<commit message>" --repo-root "."`,
                false
            )
        },
        'validate-isolation': {
            ...createSingleUsageEntry(
                'Validate isolation-mode configuration and task sandbox prerequisites.',
                `${cliPrefix} gate validate-isolation --repo-root "."`,
                false
            )
        },
        'prepare-isolation': {
            ...createSingleUsageEntry(
                'Prepare an isolation sandbox and emit preparation telemetry.',
                `${cliPrefix} gate prepare-isolation --repo-root "."`,
                false
            )
        },
        'task-reset': {
            ...createGateHelpEntry(
                'Clear task runtime artifacts and explicitly choose whether the task returns to TODO for rerun or ends as DONE terminal discard. Requires --dry-run or --confirm guard.',
                [
                    `${cliPrefix} gate task-reset --task-id "${TASK_ID_PLACEHOLDER}" --reopen --dry-run --repo-root "."`,
                    `${cliPrefix} gate task-reset --task-id "${TASK_ID_PLACEHOLDER}" --reopen --confirm --repo-root "."`,
                    `${cliPrefix} gate task-reset --task-id "${TASK_ID_PLACEHOLDER}" --discard --confirm --repo-root "."`,
                    `${cliPrefix} gate task-reset --task-id "${TASK_ID_PLACEHOLDER}" --to-status "TODO" --confirm --repo-root "."`
                ],
                true
            )
        }
    };
}

function buildGateHelpEntries(cliPrefix: string, bundleName: string): Readonly<Record<string, GateHelpEntry>> {
    return Object.freeze({
        ...buildPreflightGateHelpEntries(cliPrefix, bundleName),
        ...buildReviewGateHelpEntries(cliPrefix, bundleName),
        ...buildLifecycleGateHelpEntries(cliPrefix, bundleName)
    });
}

function getGateHelpEntries(repoRoot: string): Readonly<Record<string, GateHelpEntry>> {
    const { bundleName, cliPrefix } = buildGateHelpCatalogContext(repoRoot);
    return buildGateHelpEntries(cliPrefix, bundleName);
}

function isHelpFlag(argument: string): boolean {
    return argument === '-h' || argument === '--help';
}

function isVersionFlag(argument: string): boolean {
    return argument === '-v' || argument === '--version';
}

function canFlagConsumeNextValue(argument: string): boolean {
    return !argument.includes('=')
        && !BOOLEAN_GATE_OPTIONS.has(argument)
        && !isHelpFlag(argument)
        && !isVersionFlag(argument);
}

function buildTaskIdSyntaxMistake(
    kind: 'flag' | 'positional',
    taskId: string | null
): { kind: 'flag' | 'positional'; taskId: string | null } {
    return {
        kind,
        taskId
    };
}

function extractTaskIdFromLegacyFlag(argument: string, nextValue: string | null): string | null {
    if (argument === '--task') {
        return nextValue && TASK_ID_POSITIONAL_RE.test(nextValue) ? nextValue : null;
    }
    if (argument.startsWith('--task=')) {
        const rawValue = argument.slice('--task='.length).trim();
        return rawValue && TASK_ID_POSITIONAL_RE.test(rawValue) ? rawValue : null;
    }
    return null;
}

function isPositionalTaskId(argument: string): boolean {
    return !argument.startsWith('-') && TASK_ID_POSITIONAL_RE.test(argument);
}

function getTaskIdSyntaxMistake(
    argv: readonly string[]
): { kind: 'flag' | 'positional'; taskId: string | null } | null {
    for (let index = 0; index < argv.length;) {
        const argument = String(argv[index] || '').trim();
        if (!argument) {
            index += 1;
            continue;
        }

        const nextValue = index + 1 < argv.length && !String(argv[index + 1] || '').startsWith('-')
            ? String(argv[index + 1] || '').trim()
            : null;
        const legacyTaskId = extractTaskIdFromLegacyFlag(argument, nextValue);
        if (legacyTaskId !== null || argument === '--task' || argument.startsWith('--task=')) {
            return buildTaskIdSyntaxMistake('flag', legacyTaskId);
        }

        if (argument.startsWith('-')) {
            index += canFlagConsumeNextValue(argument) && nextValue ? 2 : 1;
            continue;
        }

        if (isPositionalTaskId(argument)) {
            return buildTaskIdSyntaxMistake('positional', argument);
        }
        index += 1;
    }

    return null;
}

function resolveSuggestedCommand(entry: GateHelpEntry, mistakenTaskId: string | null): string {
    const taskId = mistakenTaskId && TASK_ID_POSITIONAL_RE.test(mistakenTaskId)
        ? mistakenTaskId
        : TASK_ID_PLACEHOLDER;
    return entry.usage[0].split(TASK_ID_PLACEHOLDER).join(taskId);
}

export function buildGateCommandOverviewText(repoRoot = process.cwd()): string {
    const resolvedRepoRoot = resolveGateHelpRepoRoot(repoRoot);
    const { cliPrefix } = buildGateHelpCatalogContext(resolvedRepoRoot);
    return [
        'GARDA_COMMAND_HELP',
        cyan('gate'),
        dim('Run an agent gate or helper command.'),
        '',
        bold('Usage'),
        `  ${styleHelpCommandLine(`${cliPrefix} gate <gate-name> [options]`)}`,
        `  ${styleHelpCommandLine(`${cliPrefix} gate <gate-name> --help`)}`,
        '',
        bold('Hints'),
        `  ${dim('Use per-gate help to inspect exact syntax before execution.')}`,
        '',
        bold('Examples'),
        `  ${green(`${cliPrefix} gate enter-task-mode --task-id "<task-id>" --entry-mode "EXPLICIT_TASK_EXECUTION" --task-summary "<task summary>" --provider "Codex" --repo-root "."`)}`,
        `  ${green(`${cliPrefix} gate task-audit-summary --task-id "<task-id>" --as-json --repo-root "."`)}`
    ].join('\n');
}

export function buildGateHelpText(gateName: string, repoRoot = process.cwd()): string {
    const entry = getGateHelpEntry(gateName, repoRoot);
    if (!entry) {
        throw new Error(`Unknown gate: ${gateName}`);
    }
    return [
        'GARDA_COMMAND_HELP',
        `${cyan('gate')} ${cyan(gateName)}`,
        dim(entry.summary),
        '',
        bold('Usage'),
        ...entry.usage.map((line) => `  ${styleHelpCommandLine(line)}`),
        '',
        bold('Options'),
        `  ${styleHelpCommandLine('-h --help')}     ${dim('Show this gate help and exit.')}`
    ].join('\n');
}

export function getGateHelpEntry(gateName: string, repoRoot = process.cwd()): GateHelpInfo {
    const resolvedRepoRoot = resolveGateHelpRepoRoot(repoRoot);
    const entry = getGateHelpEntries(resolvedRepoRoot)[gateName];
    if (!entry) {
        throw new Error(`Unknown gate: ${gateName}`);
    }
    return {
        summary: entry.summary,
        usage: [...entry.usage]
    };
}

export function hasStandaloneGateHelpFlag(argv: readonly string[]): boolean {
    for (let index = 0; index < argv.length; index += 1) {
        const argument = String(argv[index] || '').trim();
        if (!isHelpFlag(argument)) {
            continue;
        }
        const previous = String(argv[index - 1] || '').trim();
        if (previous.startsWith('-') && canFlagConsumeNextValue(previous)) {
            if (
                HELP_PREFERRED_VALUE_OPTIONS.has(previous)
                && index === argv.length - 1
            ) {
                return true;
            }
            continue;
        }
        return true;
    }
    return false;
}

export function buildTaskIdSyntaxRemediationMessage(
    gateName: string,
    gateArgv: readonly string[],
    repoRoot = process.cwd()
): string | null {
    const resolvedRepoRoot = resolveGateHelpRepoRoot(repoRoot);
    const entry = getGateHelpEntries(resolvedRepoRoot)[gateName];
    if (!entry || !entry.taskIdRemediation) {
        return null;
    }
    const mistake = getTaskIdSyntaxMistake(gateArgv);
    if (!mistake) {
        return null;
    }
    if (gateName === 'next-step' && mistake.kind === 'positional') {
        return null;
    }
    const mistakenToken = mistake.kind === 'flag'
        ? '--task'
        : (mistake.taskId || TASK_ID_PLACEHOLDER);
    const explanation = mistake.kind === 'flag'
        ? `Unknown option: ${mistakenToken}. Canonical task-id syntax for '${gateName}' uses '--task-id', not '--task'.`
        : `Unexpected positional argument: ${mistakenToken}. Canonical task-id syntax for '${gateName}' requires '--task-id "<task-id>"', not a positional task id.`;
    return [
        explanation,
        `Suggested command: ${resolveSuggestedCommand(entry, mistake.taskId)}`
    ].join(' ');
}
