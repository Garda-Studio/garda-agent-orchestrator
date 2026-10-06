import { resolveBundleName } from '../../core/constants';
import { buildTaskStartNavigatorPrompt } from '../../core/onboarding-contract';
import {
    buildFreshMainAgentStartBannerSentence,
    START_BANNER_GATE_LIST_RULE
} from '../../core/orchestrator-start-banner';
import { formatProviderIdList, getProviderBridgeEntries } from '../../core/provider-registry';
import {
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION,
    REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION
} from '../../gate-runtime/reviewer-session-contract';
import { getNodeHumanCommitCommand } from '../command-constants';
import {
    addAntigravityCanonicalStopInstruction,
    ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION,
    COMMIT_GUARD_AGENT_MARKERS,
    COMMIT_GUARD_END,
    COMMIT_GUARD_ENV_NAME,
    COMMIT_GUARD_EXTRA_MARKERS_ENV,
    COMMIT_GUARD_START,
    extractManagedBlockFromContent,
    isAntigravityEntrypointPath,
    MANAGED_END,
    MANAGED_START,
    restoreEntrypointRuleLinks
} from './content-builders-shared';

export function buildCanonicalManagedBlock(canonicalFile: string, entrypointTemplateContent: string): string {
    const baseBlock = extractManagedBlockFromContent(entrypointTemplateContent, MANAGED_START, MANAGED_END);
    if (!baseBlock) {
        throw new Error('Entrypoint template managed block is missing; cannot build canonical entrypoint.');
    }
    const canonicalBlock = restoreEntrypointRuleLinks(baseBlock)
        .replace(/^# .+$/m, `# ${canonicalFile}`)
        .replace(
            /At setup, source of truth is selected via `-SourceOfTruth` \([^)]+\)\./,
            `At setup, source of truth is selected via \`-SourceOfTruth\` (\`${formatProviderIdList('`, `')}\`).`
        );
    return addAntigravityCanonicalStopInstruction(canonicalBlock, canonicalFile);
}

export function buildRedirectManagedBlock(
    targetFile: string,
    canonicalFile: string,
    providerBridgePaths: string[] | null | undefined
): string {
    const providerLines = [];
    const bridgeToLabel = new Map(
        getProviderBridgeEntries().map((e) => [
            e.bridge!.orchestratorRelativePath,
            e.displayLabel
        ])
    );
    for (const bridgePath of (providerBridgePaths || [])) {
        const normalized = bridgePath.replace(/\\/g, '/');
        const label = bridgeToLabel.get(normalized);
        if (label) {
            providerLines.push(`For ${label} Agents, run task execution through \`${normalized}\`.`);
        }
    }
    const uniqueProviderLines = [...new Set(providerLines)].sort();
    const providerBridgeSection = uniqueProviderLines.length > 0
        ? uniqueProviderLines.join('\r\n')
        : 'No provider-specific bridge files are enabled for this workspace.';
    const targetSpecificInstructions = isAntigravityEntrypointPath(targetFile)
        ? [ANTIGRAVITY_INDEPENDENT_REVIEW_UNAVAILABLE_STOP_INSTRUCTION]
        : [];

    return [
        MANAGED_START,
        `# ${targetFile}`,
        '',
        'This file is a redirect.',
        `Canonical source of truth for agent workflow rules: \`${canonicalFile}\`.`,
        '',
        `Hard stop: read \`${canonicalFile}\` first and follow its routing links before responding to anything.`,
        `Hard stop: before any task execution, open \`${canonicalFile}\`, \`TASK.md\`, and \`.agents/workflows/start-task.md\`.`,
        'Do not implement tasks directly without orchestration preflight and required review gates.',
        `Canonical task-start command: ${buildTaskStartNavigatorPrompt()}`,
        buildFreshMainAgentStartBannerSentence(),
        START_BANNER_GATE_LIST_RULE,
        'If the workspace already contains modified files before task-mode entry, stop and isolate scope via `--use-staged` or explicit `--changed-file ...` preflight inputs before continuing.',
        'Use compact command protocol from `40-commands.md`: first `scan`, then `inspect`, then verbose `debug` only by exception.',
        'Treat `.agents/workflows/start-task.md` as the shared start-task router for root entrypoints and provider bridges; it routes to the canonical workflow and does not replace `80-task-workflow.md`.',
        `After opening downstream workflow files, record them via \`node bin/garda.js gate load-rule-pack ...\` in a self-hosted source checkout, or \`node ${resolveBundleName()}/bin/garda.js gate load-rule-pack ...\` inside a materialized/deployed workspace.`,
        `Before each required reviewer invocation, run \`node bin/garda.js gate build-review-context ...\` in a self-hosted source checkout, or \`node ${resolveBundleName()}/bin/garda.js gate build-review-context ...\` inside a materialized/deployed workspace; completion for code-changing tasks expects review-skill telemetry from that step. ${REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION} ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION} Downstream \`test\` review must wait for current-cycle PASS evidence from every required upstream non-\`test\` review.`,
        ...targetSpecificInstructions,
        `Ignored orchestration control-plane files (for example \`TASK.md\`, \`${resolveBundleName()}/runtime/**\`, and \`${resolveBundleName()}/live/docs/changes/CHANGELOG.md\`) are expected local artifacts; never \`git add -f\` them unless the user explicitly asks to version orchestrator internals.`,
        providerBridgeSection,
        MANAGED_END
    ].join('\r\n');
}

export function buildCommitGuardManagedBlock() {
    const agentEnvLines = COMMIT_GUARD_AGENT_MARKERS.map((m) => `  "${m}"`).join('\n');
    return `${COMMIT_GUARD_START}
# Commit blocked by Garda auto-commit guard only for detected agent sessions.
if [ "\${${COMMIT_GUARD_ENV_NAME}:-}" = "1" ]; then
  exit 0
fi

garda_agent_env_markers=(
${agentEnvLines}
)

if [ -n "\${${COMMIT_GUARD_EXTRA_MARKERS_ENV}:-}" ]; then
  IFS=', ' read -r -a garda_extra_agent_markers <<< "\${${COMMIT_GUARD_EXTRA_MARKERS_ENV}}"
  for garda_marker in "\${garda_extra_agent_markers[@]}"; do
    if [[ "$garda_marker" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      garda_agent_env_markers+=("$garda_marker")
    fi
  done
fi

garda_detected_agent_var=""
for garda_marker in "\${garda_agent_env_markers[@]}"; do
  if [ -n "\${!garda_marker:-}" ]; then
    garda_detected_agent_var="$garda_marker"
    break
  fi
done

if [ -n "$garda_detected_agent_var" ]; then
  echo "Commit blocked: agent commit guard is enabled (detected env: $garda_detected_agent_var)."
  echo "For completed and audited task scope under authenticated local commit permission ON, use helper:"
  echo "  ${getNodeHumanCommitCommand().replace(/"/g, '\\"')}"
  exit 1
fi
${COMMIT_GUARD_END}`;
}
