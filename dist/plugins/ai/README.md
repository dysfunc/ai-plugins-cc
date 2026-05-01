# @ai-plugins-cc/ai

Umbrella Claude Code plugin. Routes `/ai:*` commands to whichever provider you've configured, plus runs side-by-side comparisons with `/ai:compare`.

Per-provider commands (`/codex:*`, `/gemini:*`, `/grok:*`) keep working from their own plugins — different prefixes, no collisions. Install the umbrella when you want one canonical command surface that works regardless of which provider you've set as default; install just a per-provider plugin when you want to commit to one.

## Commands

| Command | What it does |
|---|---|
| `/ai:setup` | First-run wizard: pick providers, install missing CLIs, walk through auth, verify each, save settings. |
| `/ai:settings` | Show or change which providers are enabled, the default, and the `/ai:compare` set. Interactive when called with no args; subcommands also accepted (`enable <id>`, `disable <id>`, `set-default <id>`, `set-compare <ids>`). |
| `/ai:review [--provider=ID] [...]` | Review the pending change with the configured provider. |
| `/ai:rescue [--provider=ID] <prompt>` | Hand a substantial coding task to the configured provider's agent. |
| `/ai:gater [--provider=ID]` | Run an adversarial review at session-stop time and emit `ALLOW:` / `BLOCK:`. |
| `/ai:compare [--providers=A,B,C] [...]` | Fan the review out to multiple providers in parallel; render a side-by-side report. |
| `/ai:codex-update [--tag=vX.Y.Z]` | Install or update the pinned upstream `openai/codex-plugin-cc`. Hash-verifies if a SHA is pinned in the codex-adapter. |

## First-run hook

The umbrella plugin ships a `SessionStart` hook (`scripts/first-run-hook.mjs`) that prints a one-line nudge to stderr if `~/.claude/ai-plugins-cc.json` doesn't exist yet, suggesting `/ai:setup`. It never blocks the session.

## Provider precedence

Resolved in this order — first hit wins:

1. `--provider=ID` on the command line.
2. `<workspace>/.claude-plugin/ai.json` with `{ "provider": "...", "compareProviders": [...] }`.
3. `~/.claude/ai-plugins-cc.json` (same shape).
4. `AI_PLUGINS_CC_DEFAULT_PROVIDER` env var.
5. Default: `gemini`.

`/ai:compare` uses `compareProviders` from the same files, falling back to every registered provider when not set.

## How it dispatches

The umbrella subprocesses the target provider's companion script and surfaces its output verbatim. In-house providers (gemini, grok) are reached via package resolution — each plugin exposes `@ai-plugins-cc/<provider>/meta` which publishes its `companionPath`. External providers (codex) go through `@ai-plugins-cc/codex-adapter`. The result is a uniform shape: `{ providerId, status, stdout, stderr, signal, error, timedOut, stdoutOverrun }`.

## Tests

```sh
npm test --workspace=@ai-plugins-cc/ai
```

32 tests covering:

- **Config precedence** (9): CLI → workspace → user → env → default; unknown-provider error messages.
- **In-house dispatch** (4): status capture, stderr surfacing, timeout enforcement, uniform shape.
- **Compare fan-out** (2): preserves order across mixed success and failure.
- **Codex-update wiring** (1): adapter resolves through the umbrella's dependency tree.
- **Settings persistence** (10): atomic writes, registry filtering, default-rollover on disable, ordered enable list, unknown-id rejection.
- **Subcommand integration** (6): `setup --json` shape, `settings show/enable/disable/set-default` round-trip via subprocess, `verify --provider=ID` exit codes.
