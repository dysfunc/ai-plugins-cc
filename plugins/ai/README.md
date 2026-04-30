# @ai-plugins-cc/ai

Umbrella Claude Code plugin. Routes `/ai:*` commands to whichever provider you've configured, plus runs side-by-side comparisons with `/ai:compare`.

Per-provider commands (`/codex:*`, `/gemini:*`, `/grok:*`) keep working from their own plugins — different prefixes, no collisions. Install the umbrella when you want one canonical command surface that works regardless of which provider you've set as default; install just a per-provider plugin when you want to commit to one.

## Commands

| Command | What it does |
|---|---|
| `/ai:review [--provider=ID] [...]` | Review the pending change with the configured provider. |
| `/ai:rescue [--provider=ID] <prompt>` | Hand a substantial coding task to the configured provider's agent. |
| `/ai:gater [--provider=ID]` | Run an adversarial review at session-stop time and emit `ALLOW:` / `BLOCK:`. |
| `/ai:compare [--providers=A,B,C] [...]` | Fan the review out to multiple providers in parallel; render a side-by-side report. |
| `/ai:codex-update [--tag=vX.Y.Z]` | Install or update the pinned upstream `openai/codex-plugin-cc`. Hash-verifies if a SHA is pinned in the codex-adapter. |

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

16 tests covering config precedence (CLI → workspace → user → env → default), unknown-provider error messages, in-house dispatch via a fake companion (status capture, stderr surfacing, timeout, uniform shape), compare fan-out (preserves order across mixed success and failure), and codex-update wiring through the adapter.
