# Agent Init Prompt

Read and execute this instruction completely. Do not ask the user to run scripts manually.

## Goal
Create a fully working agent orchestration workspace where canonical rules live only under `garda-agent-orchestrator/live/`, and root entrypoints route to those files.

## Required Execution Flow
1. Confirm working directory is the project root containing `garda-agent-orchestrator/`.
2. Open `garda-agent-orchestrator/runtime/init-answers.json` and determine whether all 6 mandatory answers are already present.
   - If the file already contains all 6 mandatory answers, reuse those answers instead of re-asking everything.
   - If the file already exists and is complete, **reuse all existing answers and do not ask those 6 questions again**.
   - When reusing a complete file, only validate `AssistantLanguage` before continuing:
     - normalize it to a clear agent-readable language label that other agents can understand without guesswork (for example `English`, `Russian`, `Ukrainian`, `German`);
     - if the language answer is ambiguous, typo-heavy, contradictory, or you cannot confidently map it to a single language, ask the user to clarify the language before proceeding;
     - if the language answer is ambiguous, typo-heavy, contradictory, or you cannot confidently map it to a single language, ask the user for a language clarification and do not ask the other setup questions again;
     - write the normalized language value back into `garda-agent-orchestrator/runtime/init-answers.json`.
   - If `ActiveAgentFiles` is missing, empty, or contains only the canonical source-of-truth entrypoint after CLI setup, you must ask the user which agent entrypoint files are actively used in this repository.
     - do not silently infer or expand `ActiveAgentFiles` on the user's behalf;
     - let the user explicitly confirm either canonical-only usage or a broader set such as `CLAUDE.md, AGENTS.md`;
     - present supported entrypoint files as explicit ready-made selectable options, not only as prose inside the question;
     - the visible supported option set must include: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `QWEN.md`, `.github/copilot-instructions.md`, `.windsurf/rules/rules.md`, `.junie/guidelines.md`, and `.antigravity/rules.md`;
     - if the client supports multi-select UI, use it for the supported option set;
     - if the client only supports single-choice plus free-text, ask in two steps:
       1. `Do you use only the canonical file, or multiple agent entrypoint files?`
       2. if the answer is `multiple`, ask again with the full supported option list and allow comma-separated selection;
     - do not collapse this required question into only `Only <canonical>` plus a generic `Type your answer` fallback;
     - treat this active-agent-files confirmation as a required agent-initialization question before the workspace can be considered fully initialized.
     - if this step already collected or explicitly confirmed `<active-agent-files>`, treat that answer as satisfying the mandatory `ActiveAgentFiles` question in step 3 and do not ask the identical file-list prompt again.
   - If the file is missing, invalid, or incomplete, ask only the missing mandatory answers in the exact sequence below while preserving every already valid answer.
3. When questions are required, ask missing mandatory first-run questions in this exact sequence:
   - Ask: `Which language should be used for assistant explanations and help in this project?`
   - Wait for answer and store as `<assistant-language>`.
   - Normalize `<assistant-language>` to a clear agent-readable language label before saving it.
   - If you cannot confidently normalize the answer to one language, ask a clarification question and do not continue until clarified.
   - Immediately switch all subsequent user-facing messages to `<assistant-language>`, starting with the next question.
   - In `<assistant-language>`, ask: `What response brevity should be default: concise or detailed?`
   - Wait for answer and store as `<assistant-brevity>`.
   - Only ask the `ActiveAgentFiles` question in this step if `<active-agent-files>` has not already been explicitly confirmed in step 2.
   - In `<assistant-language>`, ask: `Which agent entrypoint files do you actively use in this project? You may select multiple from CLAUDE.md, AGENTS.md, GEMINI.md, QWEN.md, .github/copilot-instructions.md, .windsurf/rules/rules.md, .junie/guidelines.md, and .antigravity/rules.md. Recommendation: include the agent files you work with most often.`
   - For that question, visibly present the supported files themselves as selectable options; do not leave them hidden only inside the sentence text.
   - If the UI supports multi-select, show the full supported option set directly.
   - If the UI does not support multi-select, first ask whether the user wants `canonical-only` or `multiple active files`, then show the full supported option set and allow comma-separated selection.
   - If step 2 already collected `<active-agent-files>`, reuse that answer here and continue to the next missing mandatory question instead of repeating the same list-selection prompt.
   - Store the answer as `<active-agent-files>`. If the user wants canonical-only usage, save exactly that canonical entrypoint as the explicit answer.
- In `<assistant-language>`, ask: `Which source-of-truth file should be canonical for rules: Claude (CLAUDE.md), Codex (AGENTS.md), Cursor (AGENTS.md, shared with Codex), DeepSeek (AGENTS.md, shared with Codex), Gemini (GEMINI.md), Qwen (QWEN.md), GitHubCopilot (.github/copilot-instructions.md), Windsurf (.windsurf/rules/rules.md), Junie (.junie/guidelines.md), or Antigravity (.antigravity/rules.md)? All non-selected entrypoint files will redirect to this selected file. Recommendation: choose the agent file you work with most often, ideally from the active files you just selected.`
   - Wait for answer and store as `<source-of-truth>`.
   - In `<assistant-language>`, ask (4th mandatory question): a localized equivalent of `Should the no-auto-commit guard be strengthened? (yes/no)`
   - Wait for answer and store as `<enforce-no-auto-commit>`.
   - In `<assistant-language>`, ask (5th mandatory question): a localized equivalent of `Give Claude full access to orchestrator files? (yes/no)`
   - Wait for answer and store as `<claude-orchestrator-full-access>`.
   - In `<assistant-language>`, ask (6th mandatory question): a localized equivalent of `Enable token-economy mode by default? (yes/no)`
   - Clarify before collecting the answer: this toggle controls reviewer-context compaction for configured depths; shared gate output filtering and fail-tail compaction still apply at any depth.
   - Wait for answer and store as `<token-economy-enabled>`.
   - Hard-stop rule: **if all 6 answers are not collected, do not run installation**.
4. Save required init answers artifact to `garda-agent-orchestrator/runtime/init-answers.json`:
```json
{
  "AssistantLanguage": "<assistant-language>",
  "AssistantBrevity": "<assistant-brevity>",
  "SourceOfTruth": "<source-of-truth>",
  "EnforceNoAutoCommit": "<enforce-no-auto-commit>",
  "ClaudeOrchestratorFullAccess": "<claude-orchestrator-full-access>",
  "TokenEconomyEnabled": "<token-economy-enabled>",
  "CollectedVia": "AGENT_INIT_PROMPT.md"
}
```
If `<active-agent-files>` was collected or explicitly confirmed, also include:
```json
{
  "ActiveAgentFiles": "<active-agent-files>"
}
```
Additional rules for saving:
- if you only reused answers created by CLI setup and made no user-facing clarifications or confirmations at all, preserve the existing `CollectedVia` value (`CLI_INTERACTIVE` or `CLI_NONINTERACTIVE`);
- set `CollectedVia` to `AGENT_INIT_PROMPT.md` if the agent had to collect one or more missing mandatory answers, clarify `AssistantLanguage`, or ask/confirm `ActiveAgentFiles`.
5. Decide whether reinstall is actually needed.
   - If `garda setup` already completed primary initialization and `garda-agent-orchestrator/live/` plus root entrypoints already exist, **do not repeat the 6 questions and do not rerun install just to reapply the same answers**.
   - Run installer only when primary initialization is incomplete, or when missing answers had to be collected and answer-dependent files still need to be materialized/refreshed.
   - If you expand `ActiveAgentFiles` beyond the canonical entrypoint, rerun installer so the additional redirect entrypoints and provider bridge files are materialized.
6. If reinstall is needed, run installer (this also runs init automatically):
```text
node garda-agent-orchestrator/bin/garda.js install --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"
```
7. Read discovery artifact and update project-context rules for this real project:
    - `garda-agent-orchestrator/live/project-discovery.md`
    - update `10-project-context.md`, `20-architecture.md`, `30-code-style.md`, `40-commands.md`, `60-operating-rules.md` with repository-specific facts.
    - Enrich project memory from real repository evidence after the deterministic templates exist:
      - execute this canonical project-memory initialization/refresh prompt:
```text
Initialize or refresh Garda project memory. Inspect the repository through the normal orchestrator workflow, starting with `garda-agent-orchestrator/live/docs/project-memory/README.md` and `garda-agent-orchestrator/live/docs/project-memory/compact.md`. Project memory is a compact project map for orientation, not proof. Read README.md, then compact.md, then only focused files relevant to the task. Verify memory facts against source, tests, config, docs, and gate evidence before changing behavior. Update only `garda-agent-orchestrator/live/docs/project-memory/*.md` files that are missing, stale, template-seeded, placeholder-only, incomplete, or no longer shaped as a compact project map. Write durable current-state contracts only: module ownership, workflow invariants, commands, decisions, risks, and active unknowns. Do not store repeated task narratives, transient failures, large command outputs, or duplicated known orchestrator issues. Task ids are optional provenance only and should not be the default heading structure. Keep `compact.md` concise and link-oriented; record confirmed stack, commands, module map, decisions, risks, and unknown/custom stack fallback from source, configs, tests, durable docs, or explicit user answers. Do not edit generated `garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md`, do not invent facts, and do not overwrite user-authored memory without preserving its facts. Record project-memory update evidence when the workflow asks for it.
```
      - read `garda-agent-orchestrator/live/docs/project-memory/README.md`, then `garda-agent-orchestrator/live/docs/project-memory/compact.md`;
      - update only `garda-agent-orchestrator/live/docs/project-memory/*.md` source files with facts found in source code, configs, tests, and durable docs;
      - treat project memory as a compact project map for orientation, not a task log or proof source;
      - write durable current-state contracts only; avoid repeated task narratives, transient failures, large command outputs, and duplicated known issues;
      - use task ids only as optional provenance when they clarify where a durable fact came from, not as the default section structure;
      - do not edit `garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md` directly; it is generated from project-memory sources by init, reinit, update, and agent-init;
      - do not invent domain architecture, stack details, commands, or ownership boundaries that cannot be traced to repository evidence or explicit user answers;
      - if the stack is unknown or custom, record the unknown/custom fallback in `stack.md`, `commands.md`, and `module-map.md` instead of forcing the project into a known framework template.
    - Ask the user a mandatory code-style policy question in `<assistant-language>` before finalizing `30-code-style.md`:
    - Before asking for the token, explain in `<assistant-language>` that this choice decides whether Garda writes only the default code-style priority rule now or also captures extra repository-specific style rules now.
    - Ask this mandatory question in a deterministic format:
      - In `<assistant-language>`, ask a localized equivalent of `StylePolicy (answer must be exactly one token: default or custom):`
      - In `<assistant-language>`, ask a localized equivalent of `Choose style-policy for `30-code-style.md`:`
      - The surrounding question text and option descriptions must follow `<assistant-language>`, but the answer tokens must remain exactly `default` and `custom`.
      - Do not ask the style-policy question as the English literal `Choose style-policy for `30-code-style.md`: default|custom` unless `<assistant-language>` is English.
      - Present the answer tokens visibly in the prompt as `default|custom`.
      - Include a concise example answer line in `<assistant-language>` that still shows the machine-safe final answer as exactly one token, such as `Example answer: default` or `Example answer: custom`.
        - `default`: `explicit project rules` first, `formatter/linter/static-analysis rules` second, and `common best practices` only if both are absent; do not copy weak, inconsistent, or legacy code patterns.
        - `custom`: keep the above priority order but add project-specific style rules now.
      - In `<assistant-language>`, explain the options in deterministic order:
        - `default`: use the repository bootstrap policy
        - `custom`: record repository-specific style rules now
      - If answer is `default`, insert this canonical default paragraph verbatim into `30-code-style.md`:
        - `The user accepted the default policy for this repository: follow explicit project rules first, formatter/linter/static-analysis rules second, and otherwise use common best practices instead of copying weak, inconsistent, or legacy code patterns.`
      - If answer is `custom`, request explicit bullets for project-specific style rules and write them to `30-code-style.md` immediately.
    - do not treat inconsistent or obviously low-quality existing code as automatic style source of truth.
    - tune `garda-agent-orchestrator/live/config/paths.json` when default path roots or trigger regexes do not fit this repository.
    - Discover likely ordinary document paths that should not trigger code/test review by default while still staying visible in evidence. Start with `CHANGELOG.md`, then add existing planning/status docs such as `docs/plan.md`, `docs/planning.md`, `docs/roadmap.md`, `PLAN.md`, `ROADMAP.md`, `TODO.md`, or `BACKLOG.md` only when they are ordinary project-planning documents.
    - Before asking for confirmation, explain in `<assistant-language>` that ordinary document paths are ordinary planning, status, changelog, roadmap, or product documentation path patterns. They are meant for files that can usually use lighter documentation-impact routing instead of code/test review.
    - In that same explanation, state plainly in `<assistant-language>` that this is only a review-routing hint: matched files still appear in preflight/doc-impact evidence, and this setting is not a global ignore list, not a way to hide files from the agent, and not a bypass for protected control-plane docs, runtime code, config/dependency/security/API/database surfaces, or mixed source changes.
    - Before persisting this list, ask the user in `<assistant-language>` to confirm the proposed `ordinary_doc_paths` list for `garda-agent-orchestrator/live/config/paths.json`.
    - Include a concise example answer in `<assistant-language>`, such as `CHANGELOG.md,docs/plan.md`, and explain that an empty answer means no ordinary document path exceptions should be persisted.
    - If the user edits the proposal, validate every entry as a relative repository path or glob with no absolute paths, no `..` segments, and no repository-wide wildcard such as `**/*`.
    - Persist the confirmed list in `garda-agent-orchestrator/live/config/paths.json` as `ordinary_doc_paths`, and remember the same comma-separated list for the final `agent-init --ordinary-doc-paths` argument.
    - Tell the user they can edit the list later in `garda-agent-orchestrator/live/config/paths.json` under the `ordinary_doc_paths` field.
8. Required optional-specialist-skills checkpoint before finalization:
   - This checkpoint is mandatory even though installing extra skills is optional.
   - Do not run `agent-init` before the user has seen the specialist-skills summary and answered the yes/no question below.
   - Ask and explain this checkpoint in `<assistant-language>`.
   - before the yes/no question, provide in `<assistant-language>`:
     - one-sentence clarification:
       - built-in pack = installable bundle of optional skills;
       - skill = actual `garda-agent-orchestrator/live/skills/<skill-id>/` directory used after installation.
     - `Already configured specialist skills`:
       - run `node garda-agent-orchestrator/bin/garda.js skills list --target-root "."`;
       - explicitly list baseline skills already available now;
       - explicitly list installed built-in optional packs from `garda-agent-orchestrator/live/config/skill-packs.json`;
       - explicitly list installed optional skill directories under `garda-agent-orchestrator/live/skills/**` separately from baseline skills;
       - run `node garda-agent-orchestrator/bin/garda.js skills suggest --target-root "."`;
     - `Available specialist skills to enable/create now`:
       - read only `garda-agent-orchestrator/live/config/skills-index.json` for optional skill discovery;
       - do not open a full optional `SKILL.md` just to decide whether it is relevant;
       - recommend only optional packs and optional skills that are not already available in baseline or already installed;
       - if a pack id overlaps a baseline skill name (for example `security-review`), explicitly label it as an optional pack and state which extra skill directory it would install;
       - recommend built-in packs from `skills list` and optional skills from `skills-index.json` based on the detected stack, task wording, and changed paths;
       - custom specialist skills that can be created via skill-builder.
     - `Recommendation for this project`:
       - provide a short recommended set of built-in packs based on the discovered stack and repository structure.
   - then ask user: `Do you want to add additional specialist skills now? (yes/no)`
   - If the user answers `no`, do not install anything; record that the question was shown by using `--skills-prompted yes` in the final `agent-init` command.
   - `--skills-prompted false` or `--skills-prompted no` means the specialist-skills question was not completed and must keep the workspace blocked.
   - if `yes`, ask:
     - `Which built-in packs should be added now?`
     - `Do you also want any custom project-specific skills created now?`
   - install built-in packs only through:
     - `node garda-agent-orchestrator/bin/garda.js skills add <pack-id> --target-root "."`
   - after the user selects a built-in pack, install it first; do not read the full optional `SKILL.md` only because the pack was selected;
   - open a full optional `SKILL.md` only later, when the selected skill is actually activated for a task, or when a hard auto-activation rule says it is required;
   - create custom specialist skills only under `garda-agent-orchestrator/live/skills/**` via:
     - `garda-agent-orchestrator/live/skills/skill-builder/SKILL.md`
   - after any built-in or custom skill change, run:
     - `node garda-agent-orchestrator/bin/garda.js skills validate --target-root "."`
     - `node garda-agent-orchestrator/bin/garda.js agent-init --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "<active-agent-files>" --project-rules-updated yes --skills-prompted yes --ordinary-doc-paths "<confirmed-ordinary-doc-paths>"`
9. Finalize agent initialization through the hard code-level gate:
```text
node garda-agent-orchestrator/bin/garda.js agent-init --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json" --active-agent-files "<active-agent-files>" --project-rules-updated yes --skills-prompted yes --ordinary-doc-paths "<confirmed-ordinary-doc-paths>"
```
This command is mandatory. It reruns answer-dependent install materialization, runs `verify`, runs manifest validation, and writes `garda-agent-orchestrator/runtime/agent-init-state.json`.
If the command fails, fix the reported issue and rerun it until it prints PASS.
10. Confirm task execution contract is navigator-first and profile/config driven:
   <!-- garda:agent-init-contract:task-execution -->
   - canonical user instruction: ``Execute task <task-id> from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.``
   - active profile selection comes from `garda-agent-orchestrator/live/config/profiles.json` and the `TASK.md` `Profile` column; inspect, switch, or create profiles through `node garda-agent-orchestrator/bin/garda.js profile ... --target-root "."`
   - do not present `depth=<1|2|3>` as normal user task-start guidance; depth remains internal gate/profile evidence unless a debug or recovery command explicitly needs it
   - run `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."` before the first gate, after every suggested command, and after any gate failure

## Compile Command Syntax

Use the same restricted command syntax for `compile_gate.command` and executable compile examples in project rules:
- An executable followed by arguments; join sequential commands with unquoted `&&`. Run the next command only after the previous command succeeds.
- Single or double quotes preserve argument boundaries and paths with spaces. Quoted `"&&"` and `'&&'` are literal arguments. Empty quoted arguments are preserved for direct executables. Executable names are literal too: `"npm "` requests a different name from `"npm"`; Garda does not trim quoted executable whitespace.
- Backslashes remain literal outside quotes. Inside double quotes, a backslash escapes a double quote or another backslash; single quotes keep their content literal.
- Do not use unquoted pipes, `||`, single `&`, redirects, semicolons, newlines, or environment assignments before an executable. Compile configuration rejects these unsupported control forms. Ordinary arguments such as `$NAME`, `folder(name)` and backticks remain literal, with no variable, command or glob expansion. Quote control operators when they are argument data; use a trusted wrapper script for shell behavior.
- On Windows, `.cmd`/`.bat` entrypoints retain their existing safety restrictions: empty arguments and literals containing quotes, percent signs, exclamation marks, NUL, CR or LF are rejected. Use a direct executable or trusted wrapper when those arguments are required.
- Keep compile/build/type-check commands separate from full-suite tests. Maven skip-test flags and Gradle test exclusions apply only to their own chain segment. `full_suite_validation.command` retains its single direct argv contract and does not accept chains; its argument syntax is validated by the same parser before the gate starts a child. Ordinary punctuation stays literal; put shell expressions that require interpretation in a trusted wrapper.
- Executable strings in `npm exec`/`npm x`/`npx` `--call` or `-c`, and pnpm shell mode, receive the same syntax and compile/test checks, including nested supported chains. Use a trusted wrapper for other shell syntax. Package names, paths and ordinary program arguments remain data.
- These executable strings are evaluated by native shells and have a narrower portable subset: inner single quotes, backslashes, expansion/escape markers (`$`, backticks, `%`, `!`, `^`), glob/home/brace markers (`*`, `?`, `[`, `]`, `{`, `}`, `~`) and newlines require a trusted wrapper, even when quoted. Unquoted grouping parentheses and shell comments also require a wrapper; parentheses inside simple double-quoted values and literal hashes such as `folder#name` remain supported. Simple double-quoted values and `&&` remain supported by the validator; the existing Windows batch quote restrictions still apply. This restriction does not reinterpret ordinary direct argv values.
- Compile configuration rejects native inline shell dispatch (`sh -c`, `cmd /c` or `/k`, PowerShell command/encoded-command options), shell dispatch builtins (`exec`, `command`, `eval`, `source`, `.`), and `env -S`/`--split-string`, including through recognized package runners. Put their executable text in a trusted wrapper file instead. Interpreter file forms such as `sh scripts/build.sh` or `pwsh -File scripts/build.ps1` remain supported; their later arguments remain data.
- In compile configuration, WSL requires the case-sensitive `--exec` or `-e` boundary followed by a nonempty program. Supported host options before it are `-d`/`--distribution`, `--distribution-id`, `-u`/`--user`, `--cd`, `--shell-type` with separate nonempty values, and boolean `--system`. Values belong to those options even when named `test`, `pytest` or `--exec`. All arguments after the program remain its literal argv; test/full-suite and inline-shell restrictions follow the delegated program, including nested package runners. Default-shell, `--option=value` and other host forms require a trusted wrapper instead.
- Configured full-suite identity is checked for each chain segment and every recognized executable boundary, including intermediate package runners beneath transparent wrappers; ordinary argument text is not reinterpreted as a command. Arbitrary executables and wrapper files remain available, and their contents are not inspected by this syntax validator.
- A chain retains at most 40 MiB of aggregate output payload plus a bounded truncation marker, preserving its beginning and latest tail and redacting the returned result. Windows and Linux use the same syntax contract; WSL host invocation applies on Windows. macOS is not validated for this change.

For example, a repository with both packages may use `npm --prefix "store frontend" run build && mvn -f "service backend/pom.xml" -DskipTests compile`. Infer actual paths and commands from the repository and preserve explicit operator choices. Configure changes through the audited `workflow set --compile-gate-command` route.

## Expected State After Success
- Selected source-of-truth entrypoint exists and routes to `garda-agent-orchestrator/live/docs/agent-rules/*`.
- All non-selected entrypoint files redirect to selected source-of-truth entrypoint.
- `garda-agent-orchestrator/live/docs/agent-rules/00-core.md` ... `90-skill-catalog.md` all exist and are non-empty.
- `garda-agent-orchestrator/live/docs/agent-rules/00-core.md` language is configured to user-selected `<assistant-language>`.
- `garda-agent-orchestrator/live/docs/agent-rules/00-core.md` default response brevity is configured to user-selected `<assistant-brevity>`.
- `garda-agent-orchestrator/live/init-report.md` exists.
- `garda-agent-orchestrator/live/project-discovery.md` exists.
- `garda-agent-orchestrator/live/source-inventory.md` exists.
- `garda-agent-orchestrator/live/docs/project-memory/README.md` and `garda-agent-orchestrator/live/docs/project-memory/compact.md` exist and were checked before readiness.
- `garda-agent-orchestrator/live/docs/agent-rules/15-project-memory.md` exists as a generated read-only summary of project-memory sources.
- `garda-agent-orchestrator/runtime/project-memory/bootstrap-report.json` exists and records project-memory bootstrap/validation status.
- `garda-agent-orchestrator/live/version.json` exists and matches `garda-agent-orchestrator/VERSION`.
- `garda-agent-orchestrator/live/config/token-economy.json` exists and its `enabled` flag matches `<token-economy-enabled>`.
- if `<enforce-no-auto-commit>` is true: `.git/hooks/pre-commit` contains Garda managed commit guard block.
- `garda-agent-orchestrator/live/config/review-capabilities.json` exists.
- A fresh init materializes `garda-agent-orchestrator/live/config/review-catalog.json`; legacy deployments where it is absent remain compatible with built-in review lanes until explicit migration.
- `garda-agent-orchestrator/live/config/paths.json` exists.
- `garda-agent-orchestrator/live/config/skill-packs.json` exists.
- `garda-agent-orchestrator/live/skills/skill-builder/SKILL.md` exists.
- `garda-agent-orchestrator/runtime/agent-init-state.json` exists and matches the finalized onboarding answers.
- `garda-agent-orchestrator/live/USAGE.md` exists with usage instructions in `<assistant-language>`.
- Root `TASK.md` contains `Profile` column in active queue (`default` inherits the workspace active profile).
- Provider-native bridge profiles exist and map back to canonical skills (`.github/agents/*.md`, `.windsurf/agents/orchestrator.md`, `.junie/agents/orchestrator.md`, `.antigravity/agents/orchestrator.md`).
- Copilot bridge profiles include specialist skills added after initialization by re-reading `live/docs/agent-rules/90-skill-catalog.md` and `live/config/review-capabilities.json`, then consume the immutable task review snapshot instead of loading the full catalog during normal execution.
- Task workflow supports per-task timeline logs at `garda-agent-orchestrator/runtime/task-events/<task-id>.jsonl`.
- Existing project docs and legacy agent files are not moved or deleted.

## Behavior Requirements
- Read existing project docs and legacy agent files as input context.
- Do not migrate files by moving/removing them.
- Keep changes minimal and deterministic.
- If `runtime/init-answers.json` already exists and is complete, reuse it instead of forcing the user through all 6 questions again.
- After `garda setup`, treat the 6 answers as already collected; the agent must not repeat them unless the file is missing, invalid, incomplete, or `AssistantLanguage` cannot be confidently recognized.
- After `garda setup`, if `ActiveAgentFiles` is still missing, empty, or canonical-only, the agent must explicitly ask the user to confirm which agent entrypoint files are actively used before declaring the workspace ready.
- When asking about `ActiveAgentFiles`, the agent must expose the supported entrypoint files as explicit visible options; it is not acceptable to offer only `Only <canonical>` plus a generic free-text input.
- When the single-choice fallback is used for `ActiveAgentFiles`, the agent may ask at most one follow-up selection question after `multiple`; once the user has provided the supported file list, do not repeat the identical file-list prompt.
- Always validate and normalize `AssistantLanguage` into a clear agent-readable label before saving or re-saving init answers.
- If `AssistantLanguage` cannot be confidently recognized, ask the user for clarification before continuing.
- Never silently infer or expand `ActiveAgentFiles`.
- Never run install before writing `garda-agent-orchestrator/runtime/init-answers.json` with all 6 required answers.
- Do not overwrite `CollectedVia=CLI_INTERACTIVE` or `CLI_NONINTERACTIVE` when you are only reusing CLI-collected answers and normalizing the language field.
- Never run final `agent-init` before asking the optional-specialist-skills yes/no question in `<assistant-language>`; user decline still counts as prompt completed, but `--skills-prompted false|no` does not.
- Never declare the workspace ready until `node garda-agent-orchestrator/bin/garda.js agent-init ...` exits PASS.
- Never declare project-memory complete only because templates were seeded; placeholder-heavy memory requires explicit, actionable warning and project-specific enrichment from real source/docs.
- Do not modify `garda-agent-orchestrator/AGENT_INIT_PROMPT.md` during project onboarding.
- Update `garda-agent-orchestrator/live/USAGE.md` as part of successful onboarding; that file is expected to become project-specific.
- Never bypass the Node CLI install flow outside this prompt.
- After `<assistant-language>` is collected, continue all following user-facing questions and reports in `<assistant-language>`.
- Treat `node garda-agent-orchestrator/bin/garda.js` as the only canonical runtime surface for lifecycle commands and gates.
- If any check fails, fix the issue and rerun checks until PASS.

## Final Report Format
- What was done.
- Result of each command (PASS or FAIL with key lines).
- Files created or updated.
- `Usage Instructions` section for the user in `<assistant-language>`, with exact next commands for:
  <!-- garda:agent-init-contract:usage-report -->
  - executing a task (``Execute task <task-id> from TASK.md strictly through the orchestrator. Use `next-step` as the navigator; when independent review is required, launch a sub-agent using your internal tools.``);
  - running `node garda-agent-orchestrator/bin/garda.js next-step "<task-id>" --repo-root "."` before the first gate, after every suggested command, and after any gate failure.
  - using the current active profile through `garda-agent-orchestrator/live/config/profiles.json`, the `TASK.md` `Profile` column, and `node garda-agent-orchestrator/bin/garda.js profile current|list|use|create --target-root "."`;
  - inspecting repo-local workflow settings with `node garda-agent-orchestrator/bin/garda.js workflow show --target-root "."` and changing them only with audited `workflow set` commands;
  - inspecting optional review capabilities with `node garda-agent-orchestrator/bin/garda.js review-capabilities list --target-root "."`;
  - inspecting optional review lanes with `node garda-agent-orchestrator/bin/garda.js review-catalog list|show|explain|validate ... --target-root "."`, while explaining that custom lanes are disabled by default and guarded mutations affect future task snapshots only;
  - explaining `workflow-config.json` review execution policy, full-suite validation, scope/review-cycle guards, project-memory maintenance, task reset, and `paths.json` `ordinary_doc_paths`;
  - if full-suite validation is disabled, state that full repository test validation after each task is disabled and the agent must not silently enable it; ask for explicit permission or show `node garda-agent-orchestrator/bin/garda.js workflow set --full-suite-enabled true --full-suite-command "<project test command>" --target-root "."`;
  - indexing note: recommend excluding `garda-agent-orchestrator/` from application-code, stack-detection, and IDE/AI semantic indexing where supported, while keeping explicit Garda rule/config/skill paths and `bin/garda.js` readable to agents.
  - where tasks are defined: tasks are managed in the root `TASK.md` file.
  - updating orchestrator workspace:
    - `node garda-agent-orchestrator/bin/garda.js check-update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"`
    - manual apply: `node garda-agent-orchestrator/bin/garda.js update --target-root "." --init-answers-path "garda-agent-orchestrator/runtime/init-answers.json"`
- Explicit orchestration note:
  - orchestrator mode starts when the agent executes a task from `TASK.md`;
  - if needed, the agent may create new tasks from user requests and then execute them through the orchestrator workflow.
- Save the full `Usage Instructions` section to `garda-agent-orchestrator/live/USAGE.md` so the user can reference it later.
- If optional specialist skills were requested:
  - list added built-in packs and newly created `garda-agent-orchestrator/live/skills/*` paths;
  - list the result of `skills validate`;
  - list any changed capability flags in `review-capabilities.json`.
- If optional specialist skills were not requested:
  - still include the presented `already configured` list, `available` list, and recommendation in the report for traceability.
- Confirmation line: `Workspace ready for task execution` only after `agent-init` passes.

## Constraints
- Do not commit.
- Do not remove unrelated files.
- Do not skip verification.
