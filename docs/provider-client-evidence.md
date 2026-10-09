# Provider client evidence

## Codex independent-review launch guidance

Use the tools and input schema declared by the current Codex client. A provider
label, model name, environment marker, or instruction-file name does not prove
that the current session can launch an independent reviewer.

The Codex session used for this observation exposes `collaboration.spawn_agent`.
Its clean-context input is `fork_turns="none"`. This is an observed interface,
not a requirement that every Codex CLI, IDE, desktop, or cloud surface must expose
that namespace. Another surface must use its own declared launch tool and
isolation parameter; `fork_context=false` applies only where the actual schema
supports it. If fresh isolated delegation is unavailable, report the blocker.
Do not substitute self-review or an automatic model/API fallback.

Prepare the native reviewer launch input before creating the fresh reviewer.
Pass the exact `CopyPasteReviewerLaunchPrompt` or reviewer-facing
`ReviewerLaunchInputArtifactPath`; `ReviewerLaunchArtifactPath` is controller
metadata. Preserve the real provider invocation identity, immediately record
native delegation start with the exact launch-input evidence, and finalize the
launch after the actual reviewer returns. Persist the validated receipt before
closing or releasing the reviewer. Model and reasoning selection remain separate
from provider identity and follow the task's authorized review requirements.

## Observation boundaries

| Item | Evidence and limit |
| --- | --- |
| Observation date | 2026-10-09 UTC |
| Source examined | `9cd2020178a2ef7e0e56854830c76d5ab73500cb`, before this instruction correction |
| Declared session tool | `collaboration.spawn_agent` with `fork_turns="none"`, from the actual session tool schema |
| Real launch evidence | The preceding owned T-079 code/test reviews used fresh isolated launches, real invocation identities, validated native receipts and post-commit acceptance; owner-local artifacts remain separate from source |
| Garda runtime | 1.4.4; this is the orchestrator version, not a Codex client version |
| Local execution platform | Linux, Node.js 24.19.0 |
| Codex desktop/app version | Unknown; no versioned desktop probe is claimed |
| Other Codex surfaces | Not probed by this correction; CLI documentation, generated text and another session's capabilities are distinct evidence |
| Other provider loading, catalog and profiles | Outside this bounded correction; unchanged provider identities and policy tiers remain compatibility contracts |

`src/core/provider/provider-registry.ts` owns provider launch metadata.
`src/gate-runtime/review/reviewer-session-contract.ts` supplies shared instruction
text consumed by task-router and standard/compact bridge generation. Registry and
materialization regressions check current-client conditional isolation, reject
the obsolete universal Codex namespace, and retain exact-input, refusal and
reviewer cleanup boundaries. These generated-text tests establish the guidance
contract; they do not certify native loading or launch capability for an
unprobed client.
