---
description: First-run wizard — pick AI providers, walk through CLI install + auth, verify each, save settings
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

You are walking the user through first-time setup of `@ai-plugins-cc/ai`. Be efficient and decisive — they want to be done, not lectured.

## Step 0: read current state

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" setup --json
```

The JSON has `providers.<id>.{ready, available, installed, loggedIn, detail}` for each registered provider, plus `settings` (current persistent config) and `knownProviders` (the registry).

If every provider the user has previously enabled is `ready: true`, tell them setup is already complete and offer `/ai:settings` if they want to change anything. Stop.

## Step 1: ask which providers they want

Use `AskUserQuestion` once with `multiSelect: true`. Options are the entries in `knownProviders`. Pre-select any provider whose probe shows `ready: true`. Suggested copy:

> Which AI providers do you want to enable? Pick any combination — you can change this later with `/ai:settings`.

For each selected provider, follow the matching block below. Run them in the order the user picked.

## Step 2: per-provider walk-through

For each selected provider:

### Gemini

If `available: false`:
- Tell the user: "I'll install the Gemini CLI. This is `npm install -g @google/gemini-cli` — confirm?"
- Use `AskUserQuestion` (single choice: Install / Skip).
- If Install: run `npm install -g @google/gemini-cli` via Bash, then run `verify --provider=gemini --json`.
- If Skip: explain that Gemini won't be enabled and stop this provider's flow.

If `loggedIn: false`:
- Use `AskUserQuestion` to ask how they want to authenticate:
  - "Set `GEMINI_API_KEY` (Google AI Studio — easiest)"
  - "Use Vertex AI via `gcloud auth application-default login`"
  - "Skip — I'll authenticate later"
- API key path: ask for the key with `AskUserQuestion` (single text answer, treat the response as sensitive — do not echo). Persist via `export GEMINI_API_KEY=…` in the user's shell config (~/.zshrc or ~/.bashrc) only if they explicitly request it; otherwise tell them to set it for the current session and they can persist later.
- Vertex path: instruct them to run `gcloud auth application-default login` in another terminal, then come back.
- Re-run `verify --provider=gemini --json` to confirm.

### Grok

Same shape:
- Missing CLI → `npm install -g grok-dev` (with confirmation).
- Missing auth → ask whether to set `GROK_API_KEY` or `XAI_API_KEY` (point at https://console.x.ai).
- Re-run `verify --provider=grok --json`.

### Codex

Codex is special — its "CLI" is the upstream `openai/codex-plugin-cc`, which we install ourselves.

If `installed: false`:
- Tell the user: "I'll install the upstream codex plugin from GitHub. This is a pinned, hash-verified release. Continue?"
- Use `AskUserQuestion` (single choice: Install / Skip).
- If Install: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" codex-update --json`. Surface the output verbatim.

If `loggedIn: false`:
- Ask whether to set `OPENAI_API_KEY` or `CODEX_API_KEY` (point at https://platform.openai.com).
- Re-run `verify --provider=codex --json`.

## Step 3: persist settings

After every selected provider verifies as `ready: true` (or the user has acknowledged a skip):

- For each ready provider: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" settings enable <id>`
- For each unready / skipped provider that's currently enabled: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" settings disable <id>`
- Ask the user which provider should be the default for `/ai:review` and `/ai:rescue`. Use `AskUserQuestion` (single choice across enabled providers). Then: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" settings set-default <id>`.

## Step 4: summary

End with a 4-line summary:
- enabled providers
- default provider
- where the settings file lives (the `settingsFile` path from `setup --json`)
- "Run `/ai:settings` any time to change this."

## Hard rules

- Never echo an API key back to the chat.
- Never modify shell config files without explicit user consent.
- If a verify step fails twice in a row, stop and surface the raw error — don't loop forever.
- Default to suggesting `/ai:settings` for later changes rather than asking too many questions up front.
