# @ai-plugins-cc/grok

Claude Code plugin that delegates to the [xAI Grok CLI](https://github.com/superagent-ai/grok-cli).

Runs on `@ai-plugins-cc/core`. Sibling of `@ai-plugins-cc/gemini`. Maintained here until an official `grok-plugin-cc` ships from xAI; at cutover this plugin will be replaced by a thin `@ai-plugins-cc/grok-adapter` (analogous to `@ai-plugins-cc/codex-adapter`) and deprecated.

## Commands

| Command | What it does |
|---|---|
| `/grok:review [--scope=diff\|repo] [--base=REF] [focus]` | Review the pending change. |
| `/grok:rescue <prompt>` | Hand a substantial task to Grok. |
| `/grok:adversarial-review` | Stricter review with explicit blocking criteria. |
| `/grok:setup` | Probe CLI install and auth state. |
| `/grok:status [--all]` | List active and recent jobs. |
| `/grok:cancel [job-id]` | Cancel a running background job. |
| `/grok:result [job-id]` | Show a finished job's output. |

## Auth

| Env var | Source |
|---|---|
| `GROK_API_KEY` | https://console.x.ai/ |
| `XAI_API_KEY` | Same; alternate name. |

`/grok:setup` reports which credential is found and whether the `grok` binary is on `PATH`.

## Tests

```sh
npm test --workspace=@ai-plugins-cc/grok
```

17 tests: a fake `grok` shim binary fixture lets the runtime tests run hermetically without a real Grok CLI install.
