export const REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION =
    'Spawn a new clean-context delegated reviewer for this review context using the provider-native/internal agent or subagent tool with the exact generated CopyPasteReviewerLaunchPrompt or reviewer-facing ReviewerLaunchInputArtifactPath from prepare-reviewer-launch, not ReviewerLaunchArtifactPath control metadata, not a shell command or hand-written artifact, and not a reconstructed prompt; do not create, reserve, hold, or complete a reviewer before launch input exists, and do not reuse an existing reviewer session. For Codex, follow the current client\'s declared tool schema; when collaboration.spawn_agent is exposed, use fork_turns="none", and use another isolation parameter only when that tool declares it. Claude should use fork_context=false when available, and other providers must use provider-equivalent isolated sub-agent or task launch. If the current provider session cannot launch a fresh delegated reviewer, stop and report that blocker instead of fabricating routing, launch, review, receipt, or telemetry evidence.';

export const REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION =
    'Launch a real subagent using built-in tools; if for some reason that is impossible right now, you must stop and report this to the user; this is expected behavior in this repository.';

export const REVIEWER_ONE_SHOT_LAUNCH_DEFAULT_INSTRUCTION =
    'After `prepare-reviewer-launch`, launch one clean-context delegated reviewer with the exact CopyPasteReviewerLaunchPrompt or reviewer-facing ReviewerLaunchInputArtifactPath, not ReviewerLaunchArtifactPath control metadata, then immediately run `record-reviewer-delegation-started` with the resolved provider reviewer identity, provider/controller invocation id, and exact launch-input evidence before the reviewer returns. Routing and preparation may use only the planned `agent:pending:<task-id>-<review-type>` identity; the resolved provider `agent:*` identity is not known until delegation start.';

export const REVIEWER_DELEGATION_STARTED_INSTRUCTION =
    'After `prepare-reviewer-launch`, launch the real delegated reviewer and immediately run `record-reviewer-delegation-started` with provider/controller invocation id plus exact launch-input evidence. Treat `complete-reviewer-launch` as post-return completion/finalization evidence, not as reviewer start.';

export const REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION =
    'Treat review context as an opaque handoff artifact. Do not open or summarize the generated review-context markdown, JSON, or scoped diff after a successful context build; pass the artifact path to the fresh delegated reviewer and inspect only gate status, paths, hashes, and reviewer output.';

export const REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION =
    'Reusing a prior review artifact or receipt is valid only through explicit current-cycle reuse evidence; reusing the same reviewer session for a new mandatory review is not valid fresh-context launch evidence.';

export const REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION =
    'After the review receipt is persisted, close or release the reviewer sub-agent session.';
