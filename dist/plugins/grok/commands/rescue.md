---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Grok rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|pro|flash>] [--dirs <path,...>] [--files <glob,...>] [--max-files <n>] [--max-file-bytes <n>] [--print-command] [what Grok should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `grok:grok-rescue` subagent via the `Agent` tool (`subagent_type: "grok:grok-rescue"`), forwarding the raw user request as the prompt.
`grok:grok-rescue` is a subagent, not a skill — do not call `Skill(grok:grok-rescue)` (no such skill) or `Skill(grok:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Grok's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `grok:grok-rescue` subagent in the background.
- If the request includes `--wait`, run the `grok:grok-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` is a runtime-selection flag. Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Grok, check for a resumable rescue transcript from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Grok thread or start a new one.
- The two choices must be:
  - `Continue current Grok thread`
  - `Start a new Grok thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Grok thread (Recommended)` first.
- Otherwise put `Start a new Grok thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

## Context flags

- `--dirs <path,...>` adds recursive text-file context from comma-separated directories. Directory names `.git`, `node_modules`, `dist`, `build`, `.next`, `.turbo`, and `coverage` are skipped while walking.
- `--files <glob,...>` adds text-file context matching comma-separated globs from the working directory. Supported glob syntax includes `**`, `*`, and `?` by path segment.
- `--max-files <n>` caps included context files. The default is 40. Files beyond the cap are reported as skipped.
- `--max-file-bytes <n>` caps bytes read from each included file. The default is 32768. Larger files are truncated and marked.
- `--print-command` prints the Grok CLI invocation preview, prompt delivery mode, assembled prompt size, included-file inventory, skipped-file summary, and prompt preview without creating a job or invoking Grok.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" task ...` and return that command's stdout as-is.
- Return the Grok companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/grok:status`, fetch `/grok:result`, call `/grok:cancel`, summarize output, or do follow-up work of its own.
- Leave the model unset unless the user explicitly asks for one. If they ask for `pro`, map it to `grok-2.5-pro`. If they ask for `flash`, map it to `grok-2.5-flash`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- Treat `--dirs`, `--files`, `--max-files`, `--max-file-bytes`, and `--print-command` as runtime/context controls. Strip them from the natural-language task text and forward them through to the subagent and final `task` call.
- If the helper reports that the Grok CLI is missing or unauthenticated, stop and tell the user to run `/grok:setup`.
- If the user did not supply a request, ask what Grok should investigate or fix.
