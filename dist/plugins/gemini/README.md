# @ai-plugins-cc/gemini

Claude Code plugin that delegates to the [Google Gemini CLI](https://github.com/google/gemini-cli).

Runs on `@ai-plugins-cc/core`. Sibling of `@ai-plugins-cc/grok`. Maintained here until an official `gemini-plugin-cc` ships from Google; at cutover this plugin will be replaced by a thin `@ai-plugins-cc/gemini-adapter` (analogous to `@ai-plugins-cc/codex-adapter`) and deprecated.

## Commands

| Command | What it does |
|---|---|
| `/gemini:review [--scope=diff\|repo] [--base=REF] [focus]` | Review the pending change. |
| `/gemini:rescue <prompt>` | Hand a substantial task to Gemini. |
| `/gemini:adversarial-review` | Stricter review with explicit blocking criteria. |
| `/gemini:setup` | Probe CLI install and auth state. |
| `/gemini:status [--all]` | List active and recent jobs. |
| `/gemini:cancel [job-id]` | Cancel a running background job. |
| `/gemini:result [job-id]` | Show a finished job's output. |

## Auth

| Env var | Source |
|---|---|
| `GEMINI_API_KEY` | https://aistudio.google.com/ |
| `GOOGLE_API_KEY` | Same; alternate name. |
| `GOOGLE_APPLICATION_CREDENTIALS` | `gcloud auth application-default login` for Vertex AI. |

`/gemini:setup` reports which credential is found and whether the `gemini` binary is on `PATH`.

## Tests

```sh
npm test --workspace=@ai-plugins-cc/gemini
```

17 tests: a fake `gemini` shim binary fixture lets the runtime tests run hermetically without a real Gemini CLI install.
