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

If `available: false`, the user already opted in by selecting Gemini — don't ask again, just install:
- Tell them once: *"Installing Gemini CLI (`npm install -g @google/gemini-cli`)…"*
- Run `npm install -g @google/gemini-cli` via Bash.
- If install fails (e.g. `EACCES` from a system-managed Node), surface the raw error verbatim and stop this provider's flow with a hint that they may need to fix npm prefix permissions or use a Node version manager.
- Re-run `verify --provider=gemini --json` after install.

If `loggedIn: false`, use `AskUserQuestion` (single choice) to pick the auth method:
  - **"Sign in with my Google account (recommended)"** — uses the Gemini CLI's OAuth flow with your personal Google account; opens a browser.
  - **"Set `GEMINI_API_KEY` from Google AI Studio"** — paste-an-API-key.
  - **"Use Vertex AI via `gcloud auth application-default login`"** — for users on Google Cloud.
  - **"Skip — I'll authenticate later"** — leaves the provider enabled but not ready.

Auth-path actions:
- **OAuth (Google account)**: run `gemini auth login` via Bash. The CLI will print a URL or open a browser; tell the user to complete the flow there. The Bash subprocess blocks until the login completes — that's expected. Re-run verify after it returns. (Note: `gemini auth login` is the developer-CLI auth subcommand, distinct from the web app's sign-in at gemini.google.com.)
- **API key**: ask for the key with `AskUserQuestion` (single text answer, treat the response as sensitive — do not echo). Tell the user to `export GEMINI_API_KEY=…` for the current session. Only modify their shell config (~/.zshrc, ~/.bashrc) if they explicitly request persistence.
- **Vertex**: instruct them to run `gcloud auth application-default login` in another terminal, come back, and acknowledge.
- Re-run `verify --provider=gemini --json` after each path completes.

### Grok

Same shape — the user already opted in by selecting Grok, so install without re-asking.

If `available: false`:
- Tell them once: *"Installing Grok CLI (`npm install -g @vibe-kit/grok-cli`)…"*
- Run `npm install -g @vibe-kit/grok-cli` via Bash. This is a Node-compatible CLI (ESM with Ink for terminal UI). The binary it installs is `grok`.
- **Avoid `grok-dev`**: that's a separate, Bun-targeted package that fails under plain Node with `Cannot find package "node:diagnostics_channel"`. If a previous install left `grok-dev` on PATH, suggest `npm uninstall -g grok-dev` first.
- Surface install failures verbatim and stop this provider's flow on a non-zero exit.
- Re-run `verify --provider=grok --json`.

If `loggedIn: false`:
- The Grok CLI is **API key only** (no SSO/OAuth flow today).
- Ask whether to set `GROK_API_KEY` or `XAI_API_KEY` (point at https://console.x.ai). Same paste-an-API-key flow as Gemini's API-key path.
- Re-run `verify --provider=grok --json`.

### Codex

Codex is special — its "CLI" is the upstream `openai/codex-plugin-cc`, which we install ourselves.

If `installed: false`, the user already opted in by selecting Codex — install without re-asking:
- Tell them once: *"Installing pinned upstream openai/codex-plugin-cc release…"*
- Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" codex-update --json`. Surface the install summary verbatim (resolved tag, SHA, install path).
- Surface install failures verbatim; common case is no network or the GitHub release feed being unreachable.

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

- **Never echo an API key back to the chat.** Treat key answers from `AskUserQuestion` as sensitive — set them in env, never quote them in your response.
- **Never modify shell config files without explicit user consent.** API keys go into the current session by default; the user can persist them themselves.
- **The user already consented to install when they selected the provider.** Don't add a second confirmation prompt before `npm install -g` or `codex-update`. Install failures (permissions, network) surface verbatim — that's the only exit.
- **If a verify step fails twice in a row, stop and surface the raw error.** Don't loop forever. Suggest the user run the failing command manually and try `/ai:setup` again.
- Default to suggesting `/ai:settings` for later changes rather than asking too many questions up front.
