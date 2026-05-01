---
description: Check whether the local Grok CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json $ARGUMENTS
```

If the result says the Grok CLI is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install the Grok CLI now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Grok CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @vibe-kit/grok-cli
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json $ARGUMENTS
```

If the Grok CLI is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If the Grok CLI is installed but not authenticated, preserve the guidance to set `GROK_API_KEY` (or `XAI_API_KEY`) with a key from https://console.x.ai.
