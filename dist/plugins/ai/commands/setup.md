---
description: First-run wizard — pick AI providers, walk through CLI install + auth, verify each, save settings
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

You are walking the user through first-time setup of `@ai-plugins-cc/ai`. Be efficient and decisive — they want to be done, not lectured.

## Step 0: read current state

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" setup
```

The non-JSON form prints a 5-7 line human-readable summary, one line per provider. Format: `- <id> [<tags>] (enabled|disabled): <detail>`. The `<detail>` field is one of:
- `ready` — provider is fully set up
- `CLI not on PATH` — provider's CLI binary needs `npm install -g ...`
- `no auth credential detected` — CLI is installed but no key/login is set
- `Sibling plugin "<id>" is not installed. Run /plugin install ...` — only fires if the umbrella's bundled fallback is also unavailable (rare)
- Anything else — drill in with `verify --provider=<id> --json` for structured detail

If every enabled provider's `<detail>` is `ready`, tell the user setup is already complete and offer `/ai:settings` if they want to change anything. Stop.

When you need structured fields (`available`, `loggedIn`, `pluginInstalled`, raw probe output) for a specific provider during the per-provider walkthrough, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" verify --provider=<id> --json` — that returns the single-provider blob without dumping all three. Avoid `setup --json` unless you genuinely need the full multi-provider snapshot; its output is ~100 lines and clutters the chat.

## Step 1: ask which providers they want

Use `AskUserQuestion` once with `multiSelect: true`. Options are the entries in `knownProviders`. Pre-select any provider whose probe shows `ready: true`. Suggested copy:

> Which AI providers do you want to enable? Pick any combination — you can change this later with `/ai:settings`.

Append `(Recommended)` to **every** option that has a viable default auth path on the local machine — that's all three of `gemini`, `grok`, and `codex`. They each install in seconds and have a clear default credential (Google API key / OAuth, xAI API key, ChatGPT login). Don't single one out as "the" recommendation — the umbrella works best with all three, and the user is the only one who knows which providers they pay for.

For each selected provider, follow the matching block below. Run them in the order the user picked.

## Step 2: per-provider walk-through

For each selected provider:

> **Important:** the umbrella plugin (`ai@ai-plugins-cc`) ships bundled fallback runtimes for Gemini and Grok at `sibling-fallback/<provider>/`. **Do not** tell the user to `/plugin install gemini@ai-plugins-cc` or `/plugin install grok@ai-plugins-cc` as a prerequisite — `resolveSiblingCompanionPath` will use the bundled fallback automatically when the per-provider Claude plugin isn't installed. The per-provider plugins are only needed if the user wants the dedicated `/gemini:*` / `/grok:*` slash commands; the `/ai:*` flow works with just the umbrella.

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
- **API key**: ask for the key with `AskUserQuestion` (single text answer, treat the response as sensitive — do not echo). Tell the user to `export GEMINI_API_KEY=…` for the current session. Only modify their shell config if they explicitly request persistence — and when they do, write to `~/.zshenv` (zsh) or `~/.bash_profile` (bash), **not** `~/.zshrc`. The `/ai:*` commands spawn non-interactive subprocesses; `~/.zshrc` is sourced for interactive shells only, so a key persisted there won't be visible to dispatch.
- **Vertex**: instruct them to run `gcloud auth application-default login` in another terminal, come back, and acknowledge.
- Re-run `verify --provider=gemini --json` after each path completes.

### Grok

Same shape — the user already opted in by selecting Grok, so install without re-asking.

If `available: false`:
- Tell them once: *"Installing Grok CLI (`npm install -g @vibe-kit/grok-cli`)…"*
- Run `npm install -g @vibe-kit/grok-cli` via Bash. This is a Node-compatible CLI (ESM with Ink for terminal UI). The binary it installs is `grok`.
- **Avoid `grok-dev`**: that's a separate, Bun-targeted package that fails under plain Node with `Cannot find package "node:diagnostics_channel"`. If a previous install left `grok-dev` on PATH, suggest `npm uninstall -g grok-dev` first.
- Surface install failures verbatim and stop this provider's flow on a non-zero exit.

Then — **whether Grok was just installed or was already on PATH** — apply the live-search compatibility patch before verify:
- Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ai-companion.mjs" grok-patch --json`. The umbrella locates the grok plugin's patch script (`plugins/grok/scripts/patch-grok-cli.mjs`) and runs it. The script is idempotent (`patched` and `already-patched` are both OK) but **fails closed** if the expected pattern isn't found in the installed grok-cli — that's a signal that upstream may have updated and the patch may no longer be needed.
- Why this is necessary: `@vibe-kit/grok-cli`'s `client.js` sends a deprecated `search_parameters: { mode: "off" }` field on every chat call, which xAI rejects with `410 "Live search is deprecated"` for accounts without a Live Search license (i.e. most new teams). The patch removes the offending lines.
- The patch must be re-applied after every `npm install -g @vibe-kit/grok-cli` upgrade, because `npm install` overwrites the file. Re-running `/ai:setup` is one way to do that.
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
